// Test of the Google-bridge adapter (bridge/google/ingest.mjs) against the QuitFind TEST server.
// No Google involved: the test plays the role of the Google bridge and sends OsmAnd requests.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, b64, encItem } from '../lib/quitfind_v2.mjs';
import { createIngest } from '../bridge/google/ingest.mjs';

const base = process.argv[2] || 'http://127.0.0.1:8096';
assert.ok(!/:8090|:8443|debian\./.test(base), 'refusing to run against the real FMD server');
const regToken = /RegistrationToken:\s*"([^"]*)"/.exec(readFileSync(new URL('../test-instance/config.yml', import.meta.url), 'utf8'))?.[1] ?? '';
const api = new Client(base), rnd = () => crypto.randomBytes(8).toString('hex'), created = [];
let srv;
try {
  const owner = await api.register(`qf-owner-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(owner);
  const tag = await api.register(`t-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(tag);
  await api.addDevice(owner, { username: tag.username, pwk64: b64(tag.pwk), name: 'Sleutels', type: 'tag', tag: { kind: 'fmdn', id: 'google-tracker-1' } });
  const settings = (mode) => api.postData(owner, 'device', [encItem(owner.keks.device, 'device', owner.username, { v: 1, kind: 'settings', registrationToken: regToken, googleBridge: mode })]);
  await settings('off');

  const key = crypto.randomBytes(24).toString('base64url');
  srv = createIngest({ server: base, owner: owner.username, ownerPwk64: b64(owner.pwk), key, refreshMs: 0 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const t = Math.floor(Date.parse('2026-11-27T12:00:00Z') / 1000);
  const q = (o) => fetch(url + '?' + new URLSearchParams({ key, id: tag.username, lat: '52.0907', lon: '5.1214', timestamp: String(t), accuracy: '12', status: 'CROWDSOURCED', ...o })).then(async (r) => [r.status, (await r.text()).trim()]);

  assert.equal((await q({ key: 'x'.repeat(key.length) }))[0], 401);
  assert.equal((await q({ lat: 'abc' }))[0], 400);
  assert.equal((await q({ lat: '95' }))[0], 400);
  assert.equal((await q({}))[0], 403, 'bridge off in the settings');
  console.log('ok  sleutel, invoer en uit-stand geweigerd');

  await settings('server'); // the newest settings item wins
  assert.equal((await q({ id: 't-onbekend' }))[0], 404);
  assert.deepEqual(await q({}), [200, 'ok']);
  assert.deepEqual(await q({}), [200, 'dubbel']);
  // OsmAnd form POST (PUSH_URL of the bridge) with an ISO timestamp
  const post = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key, id: tag.username, lat: '52.1', lon: '5.13', timestamp: '2026-11-27T12:05:00Z' }) });
  assert.equal(post.status, 200);

  const locs = (await api.locations(await api.login(tag.username, { pwk: tag.pwk }))).sort((a, b) => a.date - b.date);
  assert.equal(locs.length, 2);
  assert.deepEqual([locs[0].provider, locs[0].lat, locs[0].accuracy, locs[0].status, locs[0].date], ['google', 52.0907, 12, 'CROWDSOURCED', t * 1000]);
  assert.equal(locs[1].date, Date.parse('2026-11-27T12:05:00Z'));
  console.log('ok  locaties via de brug versleuteld in het tag-account (GET en POST, dubbel overgeslagen)');
} finally {
  srv?.close();
  for (const s of created.reverse()) await api.deleteAccount(s).catch((e) => console.error('opruimen mislukt:', e.message));
  console.log(`opgeruimd: ${created.length} accounts`);
}
