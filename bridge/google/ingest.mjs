// QuitFind Google-brug A: ingest-adapter.
// De Google-brug (een aparte container, zie LEESMIJ.md) haalt de locaties van je Find Hub-tags bij Google op
// en stuurt elke locatie hierheen in het OsmAnd/Traccar-formaat. Deze adapter controleert de sleutel, zoekt de
// tag op in je apparatenregister en slaat de locatie versleuteld op in het account van die tag.
// Hier zit geen Google-code: alleen QuitFind/FMD-protocol v2 (lib/quitfind_v2.mjs). Geen npm-pakketten.
//
// Starten:  QF_SERVER=https://… QF_OWNER=<eigenaar> QF_OWNER_PWK64_FILE=<bestand> QF_INGEST_KEY_FILE=<bestand> \
//           node bridge/google/ingest.mjs          (luistert standaard op 127.0.0.1:5055, QF_LISTEN=host:poort)
// De brug staat alleen aan als in het register (instellingen) "Google-brug: A, via de server" gekozen is.
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, encItem, unb64 } from '../../lib/quitfind_v2.mjs';

const num = (v) => (v === null || v === '' ? NaN : Number(v));

// OsmAnd: timestamp in seconden, milliseconden of ISO-tekst
function parseTime(v) {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  return Date.parse(v);
}

export function createIngest({ server, owner, ownerPwk64, key, refreshMs = 10 * 60_000 }) {
  if (!server || !owner || !ownerPwk64 || !key || key.length < 16) throw new Error('config incompleet (sleutel ≥ 16 tekens)');
  const api = new Client(server);
  const keyBuf = Buffer.from(key);
  let ownerSession = null, register = null, loadedAt = 0;
  const sessions = new Map(), refused = new Set(), lastMs = new Map();

  async function withOwner(fn) {
    if (!ownerSession) ownerSession = await api.login(owner, { pwk: unb64(ownerPwk64) });
    try {
      return await fn(ownerSession);
    } catch (e) {
      if (e.status !== 401) throw e; // token weg (herstart server of verlopen): één keer opnieuw
      ownerSession = await api.login(owner, { pwk: unb64(ownerPwk64) });
      return fn(ownerSession);
    }
  }
  async function loadRegister(force) {
    if (force || !register || Date.now() - loadedAt > refreshMs) {
      register = await withOwner((s) => api.register_(s));
      loadedAt = Date.now();
    }
    return register;
  }
  async function upload(entry, loc) {
    const login = () => api.login(entry.username, { pwk: unb64(entry.pwk64) });
    let s = sessions.get(entry.username) ?? (await login());
    sessions.set(entry.username, s);
    const post = (sess) => api.postData(sess, 'location', [encItem(sess.keks.location, 'location', sess.username, loc, loc.date)]);
    try {
      await post(s);
    } catch (e) {
      if (e.status !== 401) throw e;
      s = await login();
      sessions.set(entry.username, s);
      await post(s);
    }
  }

  async function handle(p) {
    const k = Buffer.from(p.get('key') ?? '');
    if (k.length !== keyBuf.length || !crypto.timingSafeEqual(k, keyBuf)) return [401, 'verkeerde sleutel'];
    const id = p.get('id') ?? p.get('deviceid') ?? '';
    const lat = num(p.get('lat')), lon = num(p.get('lon')), ms = parseTime(p.get('timestamp'));
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) return [400, 'ongeldige id'];
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || !Number.isFinite(ms)) return [400, 'ongeldige locatie of tijd'];
    if (ms > Date.now() + 10 * 60_000) return [400, 'tijd ligt in de toekomst'];

    let reg = await loadRegister(false);
    const settings = reg.findLast((e) => e.kind === 'settings');
    const find = (r) => r.findLast((e) => e.kind === 'device' && e.type === 'tag' && e.username === id);
    let entry = find(reg);
    if (!entry || settings?.googleBridge !== 'server') {
      reg = await loadRegister(true); // net toegevoegd of net aangezet? dan staat het er na herladen wel
      entry = find(reg);
    }
    if (reg.findLast((e) => e.kind === 'settings')?.googleBridge !== 'server') return [403, 'Google-brug staat uit (instellingen)'];
    if (!entry) return [404, 'onbekende tag'];
    if (refused.has(id)) return [403, 'sleutel van deze tag geweigerd: koppel hem opnieuw'];
    if (lastMs.get(id) === ms) return [200, 'dubbel'];

    const acc = num(p.get('accuracy')), alt = num(p.get('altitude')), status = p.get('status');
    const loc = { provider: 'google', lat, lon, bat: -1, date: ms, time: new Date(ms).toString() };
    if (Number.isFinite(acc) && acc >= 0) loc.accuracy = acc;
    if (Number.isFinite(alt)) loc.altitude = alt;
    if (status && /^[A-Z_]{1,32}$/.test(status)) loc.status = status; // LAST_KNOWN / CROWDSOURCED / AGGREGATED
    try {
      await upload(entry, loc);
    } catch (e) {
      // nooit blijven proberen: 7 mislukte logins zetten het tag-account 10 minuten op slot
      if ([403, 404, 423].includes(e.status)) refused.add(id);
      throw e;
    }
    lastMs.set(id, ms);
    return [200, 'ok'];
  }

  return http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 10_000) return res.writeHead(413).end();
    }
    const p = new URL(req.url, 'http://adapter').searchParams;
    if (req.method === 'POST') for (const [k, v] of new URLSearchParams(body)) p.set(k, v);
    const [status, text] = await handle(p).catch((e) => [502, 'server: ' + e.message]);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text + '\n');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env, read = (f) => readFileSync(f, 'utf8').trim();
  const [host, port] = (env.QF_LISTEN || '127.0.0.1:5055').split(':');
  const srv = createIngest({
    server: env.QF_SERVER,
    owner: env.QF_OWNER,
    ownerPwk64: env.QF_OWNER_PWK64_FILE ? read(env.QF_OWNER_PWK64_FILE) : env.QF_OWNER_PWK64,
    key: env.QF_INGEST_KEY_FILE ? read(env.QF_INGEST_KEY_FILE) : env.QF_INGEST_KEY,
  });
  srv.listen(Number(port), host, () => console.log(`QuitFind Google-brug (adapter) luistert op ${host}:${port}`));
}
