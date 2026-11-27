// QuitFind/FMD protocol-v2 client for Node (>= 24.7, only built-in modules).
// Used by the end-to-end tests; the crypto matches tests/fmd_v2_vectors.mjs (checked against
// the Kotlin unit-test vectors of FMD Android). See docs/apparatenregister.md for the register.
import crypto from 'node:crypto';

const utf8 = (s) => Buffer.from(s, 'utf8');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
const be64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64');

function gcmEnc(key, pt, aad) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]);
}
function gcmDec(key, blob, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

export function passwordKey(username, password, salt) {
  return crypto.argon2Sync('argon2id', {
    message: Buffer.concat([utf8('fmd_v2_password'), sha256(utf8(username)), utf8(password)]),
    nonce: salt, parallelism: 4, tagLength: 32, memory: 131072, passes: 1,
  });
}
export const authKey = (username, pwk) => hkdf(pwk, Buffer.concat([utf8('fmd_v2_auth'), sha256(utf8(username))]));
const premasterKey = (username, pwk) => hkdf(pwk, Buffer.concat([utf8('fmd_v2_premaster'), sha256(utf8(username))]));
const masterAad = (username) => Buffer.concat([utf8('fmd_v2_master'), sha256(utf8(username))]);

export function keks(username, mk) {
  const hU = sha256(utf8(username)), d = (ctx) => hkdf(mk, Buffer.concat([utf8(ctx), hU]));
  return {
    command: d('fmd_v2_kek_command'), location: d('fmd_v2_kek_location'), picture: d('fmd_v2_kek_picture'),
    device: d('quitfind_v1_kek_device'),  // QuitFind: own context for the device register
  };
}

const adSuffix = (type, username, id, ms) => Buffer.concat([utf8(type), sha256(utf8(username)), id, be64(ms)]);
export function encItem(kek, type, username, obj, ms = Date.now()) {
  const id = crypto.randomBytes(16), dek = crypto.randomBytes(32), s = adSuffix(type, username, id, ms);
  const blob = Buffer.concat([
    gcmEnc(kek, dek, Buffer.concat([utf8('fmd_v2_dek_'), s])),
    gcmEnc(dek, utf8(JSON.stringify(obj)), Buffer.concat([utf8('fmd_v2_data_'), s])),
  ]);
  return { clientItemIdHex: id.toString('hex'), unixMillis: ms, ciphertext64: b64(blob) };
}
export function decItem(kek, type, username, item) {
  const id = Buffer.from(item.clientItemIdHex, 'hex'), blob = unb64(item.ciphertext64);
  if (blob.length < 88) throw new Error('ciphertext too short');
  const s = adSuffix(type, username, id, item.unixMillis);
  const dek = gcmDec(kek, blob.subarray(0, 60), Buffer.concat([utf8('fmd_v2_dek_'), s]));
  return JSON.parse(gcmDec(dek, blob.subarray(60), Buffer.concat([utf8('fmd_v2_data_'), s])).toString('utf8'));
}

export class Client {
  constructor(base) { this.base = base.replace(/\/$/, '') + '/api/v2'; }
  async call(method, path, body, token) {
    const r = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${r.status} ${text.trim()}`), { status: r.status });
    return text ? JSON.parse(text) : {};
  }
  // Register a new v2 account; returns the session the server opens automatically.
  async register(username, password, registrationToken) {
    const salt = crypto.randomBytes(16), pwk = passwordKey(username, password, salt), mk = crypto.randomBytes(32);
    const { accessToken } = await this.call('POST', '/account/register', {
      username, salt64: b64(salt), passwordHash64: b64(authKey(username, pwk)), protoVersion: 2,
      encMasterKey64: b64(gcmEnc(premasterKey(username, pwk), mk, masterAad(username))), registrationToken,
    });
    return { username, pwk, mk, token: accessToken, keks: keks(username, mk) };
  }
  // Log in with the password (one Argon2 run) or with a stored K_pwk (no Argon2).
  async login(username, { password, pwk } = {}, sessionDurationSeconds = 604800) {
    if (!pwk) {
      const { salt64, protoVersion } = await this.call('GET', `/account/${encodeURIComponent(username)}/salt`);
      if (protoVersion !== 2) throw new Error(`account ${username} uses protocol v${protoVersion}`);
      pwk = passwordKey(username, password, unb64(salt64));
    }
    const { accessToken, encMasterKey64 } = await this.call('POST', '/account/login',
      { username, passwordHash64: b64(authKey(username, pwk)), sessionDurationSeconds });
    const mk = gcmDec(premasterKey(username, pwk), unb64(encMasterKey64), masterAad(username));
    return { username, pwk, mk, token: accessToken, keks: keks(username, mk) };
  }
  getData(s, type) { return this.call('GET', `/data/${type}`, undefined, s.token).then((r) => r.items || []); }
  postData(s, type, items) { return this.call('POST', `/data/${type}`, { items }, s.token); }
  deleteItem(s, type, id) { return this.call('DELETE', `/data/${type}/${id}`, undefined, s.token); }
  deleteAccount(s) { return this.call('DELETE', '/account', undefined, s.token); }

  // ---- QuitFind helpers ----
  async addLocations(s, locations) {
    return this.postData(s, 'location', locations.map((l) => encItem(s.keks.location, 'location', s.username, l, l.date)));
  }
  async locations(s) {
    return (await this.getData(s, 'location')).map((it) => decItem(s.keks.location, 'location', s.username, it));
  }
  async addDevice(owner, entry) {
    const item = encItem(owner.keks.device, 'device', owner.username, { v: 1, kind: 'device', server: '', addedAt: Date.now(), ...entry });
    await this.postData(owner, 'device', [item]);
    return item.clientItemIdHex;
  }
  async register_(owner) {  // read and decrypt the owner's device register
    return (await this.getData(owner, 'device')).map((it) => ({ id: it.clientItemIdHex, ...decItem(owner.keks.device, 'device', owner.username, it) }));
  }
}
export { b64, unb64 };
