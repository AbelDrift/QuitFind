// FMD Server Protocol v2 reference (Node >= 24.7, built-in crypto only).
// Checks against the Kotlin unit-test vectors (android/.../CryptoV2Test.kt) and prints
// deterministic vectors for the remaining steps (master-key wrap, KEKs, data blob, server hash).
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const u8 = (...a) => Buffer.from(a);
const seq = (start, n) => Buffer.from(Array.from({ length: n }, (_, i) => (start + i) & 0xff));
const hex = (b) => Buffer.from(b).toString('hex');
const b64 = (b) => Buffer.from(b).toString('base64');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');

// HKDF-SHA256, empty salt (== 32 zero bytes per RFC 5869), 32-byte output
const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));

const argon2id = (message, nonce) =>
  crypto.argon2Sync('argon2id', { message, nonce, parallelism: 4, tagLength: 32, memory: 131072, passes: 1 });

function gcmEnc(key, iv, pt, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  return Buffer.concat([iv, c.update(pt), c.final(), c.getAuthTag()]); // IV || CT || TAG
}
function gcmDec(key, blob, aad) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(blob.length - 16), ct = blob.subarray(12, blob.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
const be64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

function passwordKeys(username, password, salt) {
  const hU = sha256(utf8(username));
  const pwk = argon2id(Buffer.concat([utf8('fmd_v2_password'), hU, utf8(password)]), salt);
  return {
    pwk,
    auth: hkdf(pwk, Buffer.concat([utf8('fmd_v2_auth'), hU])),
    pmk: hkdf(pwk, Buffer.concat([utf8('fmd_v2_premaster'), hU])),
  };
}
const keks = (username, mk) => {
  const hU = sha256(utf8(username));
  const d = (ctx) => hkdf(mk, Buffer.concat([utf8(ctx), hU]));
  return { command: d('fmd_v2_kek_command'), location: d('fmd_v2_kek_location'), picture: d('fmd_v2_kek_picture') };
};
const adSuffix = (type, username, id, ms) => Buffer.concat([utf8(type), sha256(utf8(username)), id, be64(ms)]);
function encBlob(kek, type, username, id, ms, dek, ivDek, ivData, pt) {
  const s = adSuffix(type, username, id, ms);
  return Buffer.concat([
    gcmEnc(kek, ivDek, dek, Buffer.concat([utf8('fmd_v2_dek_'), s])),
    gcmEnc(dek, ivData, pt, Buffer.concat([utf8('fmd_v2_data_'), s])),
  ]);
}
function decBlob(kek, type, username, id, ms, blob) {
  const s = adSuffix(type, username, id, ms);
  const dek = gcmDec(kek, blob.subarray(0, 60), Buffer.concat([utf8('fmd_v2_dek_'), s]));
  return gcmDec(dek, blob.subarray(60), Buffer.concat([utf8('fmd_v2_data_'), s]));
}
const serverHash = (authKey) =>
  'pw-v2:sha-512:' + crypto.createHash('sha512').update('context:serverSidePasswordHash' + hex(authKey)).digest('base64').replace(/=+$/, '');

// ---- 1. Kotlin unit-test vectors (CryptoV2Test.kt) ----
assert.equal(hex(sha256(utf8('FMD'))), 'b1277434dfe465a19f1db16df75f0cb28324b3692a852989c4dfeb865d347e85');
assert.equal(hex(hkdf(Buffer.alloc(32, 41), utf8('fmd_v2_unit_test'))), '64394c58796450367852bd9a8effc2d1a76232958b0bca9ad4b59d15f33c38a8');
const k32 = passwordKeys('alice', 'password', Buffer.alloc(32, 41));
assert.equal(hex(k32.auth), '35fb781014180916aeaecb65e031b9af3cf5326caabaa7b72f619065c9e9e2ce');
assert.equal(hex(k32.pmk), 'd15f59206fc419ece0d86dd85fb8e4a99f9aeea7d6f9652378cea43f97767c10');
console.log('OK  Kotlin vectors (sha256, hkdf, argon2id+hkdf) reproduced');
console.log('V1  salt=0x29*32 alice/password  K_pwk =', hex(k32.pwk));

// ---- 2. Real-size (16-byte) salt, deterministic ----
const user = 'alice', salt16 = Buffer.alloc(16, 41);
const k = passwordKeys(user, 'password', salt16);
console.log('V2  salt16=0x29*16 salt64       =', b64(salt16));
console.log('V2  K_pwk  =', hex(k.pwk));
console.log('V2  K_auth =', hex(k.auth), ' passwordHash64 =', b64(k.auth));
console.log('V2  K_pmk  =', hex(k.pmk));
console.log('V2  server hashed_password      =', serverHash(k.auth));

// ---- 3. Master-key wrap ----
const mk = seq(0x00, 32), ivM = seq(0xa0, 12);
const encMk = gcmEnc(k.pmk, ivM, mk, Buffer.concat([utf8('fmd_v2_master'), sha256(utf8(user))]));
assert.equal(encMk.length, 60);
assert.deepEqual(gcmDec(k.pmk, encMk, Buffer.concat([utf8('fmd_v2_master'), sha256(utf8(user))])), mk);
console.log('V3  K_master=00..1f IV=a0..ab  encMasterKey64 =', b64(encMk));
console.log('V3  fingerprint sha256(K_master) =', hex(sha256(mk)));

// ---- 4. KEKs ----
const kk = keks(user, mk);
for (const [t, v] of Object.entries(kk)) console.log(`V4  K_kek_${t} =`, hex(v));

// ---- 5. Data blob (location) ----
const id = seq(0x10, 16), ms = 1700000000000, dek = seq(0x20, 32), ivDek = seq(0xb0, 12), ivData = seq(0xc0, 12);
const pt = utf8('{"provider":"gps","lat":52.37,"lon":4.89,"accuracy":10,"bat":77,"date":1700000000000,"time":"Tue Nov 14 22:13:20 UTC 2023"}');
const blob = encBlob(kk.location, 'location', user, id, ms, dek, ivDek, ivData, pt);
assert.equal(blob.length, 12 + 48 + 12 + pt.length + 16);
console.log('V5  AD_dek  =', hex(Buffer.concat([utf8('fmd_v2_dek_'), adSuffix('location', user, id, ms)])));
console.log('V5  item    =', JSON.stringify({ clientItemIdHex: hex(id), unixMillis: ms, ciphertext64: b64(blob) }));
assert.deepEqual(decBlob(kk.location, 'location', user, id, ms, blob), pt);
assert.throws(() => decBlob(kk.location, 'location', user, id, ms + 1, blob)); // timestamp is bound
assert.throws(() => decBlob(kk.picture, 'picture', user, id, ms, blob)); // type is bound
assert.throws(() => decBlob(kk.location, 'location', 'bob', id, ms, blob)); // user is bound
console.log('OK  round-trip + negative checks');

// ---- 6. QuitFind device register (docs/apparatenregister.md) ----
const kDev = hkdf(mk, Buffer.concat([utf8('quitfind_v1_kek_device'), sha256(utf8(user))]));
console.log('V6  K_kek_device =', hex(kDev));
const devPt = utf8('{"v":1,"kind":"device","username":"qf-phone","server":"","pwk64":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=","name":"Fairphone","type":"phone","addedAt":1700000000000}');
const devId = seq(0x30, 16), devBlob = encBlob(kDev, 'device', user, devId, ms, seq(0x40, 32), seq(0xd0, 12), seq(0xe0, 12), devPt);
console.log('V6  item    =', JSON.stringify({ clientItemIdHex: hex(devId), unixMillis: ms, ciphertext64: b64(devBlob) }));
assert.deepEqual(decBlob(kDev, 'device', user, devId, ms, devBlob), devPt);
assert.throws(() => decBlob(kk.location, 'device', user, devId, ms, devBlob)); // other KEK
console.log('OK  device register vector');
