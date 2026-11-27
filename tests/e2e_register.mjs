// End-to-end test against the QuitFind TEST server (default http://127.0.0.1:8096), never the real one.
// Creates an owner account, a phone, a laptop and a tag; fills the device register; uploads locations
// (including a tag sighting reported by the phone); then reads everything back as a fresh client.
// All accounts are deleted at the end. Usage: node tests/e2e_register.mjs [baseUrl]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, b64, unb64, encItem, decItem } from './quitfind_v2.mjs';

const base = process.argv[2] || 'http://127.0.0.1:8096';
assert.ok(!/:8090|:8443|debian\./.test(base), 'refusing to run against the real FMD server');
const cfg = readFileSync(new URL('../test-instance/config.yml', import.meta.url), 'utf8');
const regToken = /RegistrationToken:\s*"([^"]*)"/.exec(cfg)?.[1] ?? '';
const api = new Client(base), rnd = () => crypto.randomBytes(8).toString('hex');
const created = [];

try {
  // 1. accounts (one Argon2 run each, sequentially: 128 MiB)
  const owner = await api.register(`qf-owner-${rnd()}`, 'eigenaar-wachtwoord', regToken); created.push(owner);
  const phone = await api.register(`qf-phone-${rnd()}`, 'telefoon-wachtwoord', regToken); created.push(phone);
  const laptop = await api.register(`qf-laptop-${rnd()}`, 'laptop-wachtwoord', regToken); created.push(laptop);
  const tag = await api.register(`t-${rnd()}`, crypto.randomBytes(24).toString('base64'), regToken); created.push(tag);
  console.log('ok  4 accounts aangemaakt');

  // 2. device register in the owner account
  await api.addDevice(owner, { username: phone.username, pwk64: b64(phone.pwk), name: 'Fairphone', type: 'phone' });
  await api.addDevice(owner, { username: laptop.username, pwk64: b64(laptop.pwk), name: 'Laptop', type: 'laptop' });
  await api.addDevice(owner, { username: tag.username, pwk64: b64(tag.pwk), name: 'Sleutels', type: 'tag', tag: { kind: 'mac', id: 'AA:BB:CC:DD:EE:FF' } });
  await api.postData(owner, 'device', [encItem(owner.keks.device, 'device', owner.username, { v: 1, kind: 'settings', registrationToken: regToken })]);

  // 3. locations: the devices upload their own; the phone reports the tag it saw (logs in with the tag's K_pwk)
  const t0 = Date.parse('2026-11-27T10:00:00Z');
  await api.addLocations(phone, [
    { provider: 'gps', lat: 52.3702, lon: 4.8952, accuracy: 8, bat: 81, date: t0 },
    { provider: 'gps', lat: 52.3710, lon: 4.8960, accuracy: 6, bat: 80, date: t0 + 60_000 },
  ]);
  await api.addLocations(laptop, [{ provider: 'network', lat: 52.0907, lon: 5.1214, accuracy: 30, bat: 55, date: t0 }]);
  const asReporter = await api.login(tag.username, { pwk: tag.pwk });  // no Argon2 needed
  await api.addLocations(asReporter, [{ provider: 'ble', lat: 52.3709, lon: 4.8961, accuracy: 15, bat: -1, date: t0 + 90_000, seenBy: phone.username, rssi: -71 }]);
  console.log('ok  locaties geüpload (incl. tagwaarneming via de telefoon)');

  // 4. a fresh client: owner password → register → every device via its K_pwk → decrypt all locations
  const fresh = new Client(base);
  const o2 = await fresh.login(owner.username, { password: 'eigenaar-wachtwoord' });
  const reg = await fresh.register_(o2);
  const devices = reg.filter((e) => e.kind === 'device');
  assert.equal(devices.length, 3);
  assert.equal(reg.find((e) => e.kind === 'settings')?.registrationToken, regToken);
  const map = {};
  for (const d of devices) {
    const s = await fresh.login(d.username, { pwk: unb64(d.pwk64) });
    map[d.name] = await fresh.locations(s);
  }
  assert.equal(map.Fairphone.length, 2);
  assert.equal(map.Laptop[0].lat, 52.0907);
  assert.equal(map.Sleutels[0].provider, 'ble');
  assert.equal(map.Sleutels[0].seenBy, phone.username);
  console.log('ok  verse client ziet', Object.entries(map).map(([n, l]) => `${n}: ${l.length}`).join(', '));

  // 5. tampering: a location item cannot be read as a device item (type bound into the AAD)
  const [raw] = await api.getData(phone, 'location');
  assert.throws(() => decItem(phone.keks.device, 'device', phone.username, raw));
  // removing a device from the register
  await fresh.deleteItem(o2, 'device', devices.find((d) => d.name === 'Laptop').id);
  assert.equal((await fresh.register_(o2)).filter((e) => e.kind === 'device').length, 2);
  console.log('ok  manipulatie geweigerd, apparaat verwijderd');
} finally {
  for (const s of created.reverse()) await api.deleteAccount(s).catch((e) => console.error('opruimen mislukt:', e.message));
  console.log(`opgeruimd: ${created.length} accounts`);
}
