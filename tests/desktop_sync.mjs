// End-to-end test of the Rust desktop sync (desktop/src/fmd.rs) against the QuitFind TEST server.
// Node creates an owner, a phone (2 locations), a tag (seen by the phone) and a device with a stale key;
// then `cargo test sync_against_test_server -- --ignored` must see exactly that. Accounts are deleted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, b64 } from './quitfind_v2.mjs';

const base = process.argv[2] || 'http://127.0.0.1:8096';
assert.ok(!/:8090|:8443|debian\./.test(base), 'refusing to run against the real FMD server');
const regToken = /RegistrationToken:\s*"([^"]*)"/.exec(readFileSync(new URL('../test-instance/config.yml', import.meta.url), 'utf8'))?.[1] ?? '';
const api = new Client(base), rnd = () => crypto.randomBytes(8).toString('hex'), created = [];
try {
  const owner = await api.register(`qf-owner-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(owner);
  const phone = await api.register(`qf-phone-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(phone);
  const tag = await api.register(`t-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(tag);
  const old = await api.register(`qf-old-${rnd()}`, crypto.randomBytes(18).toString('base64'), regToken); created.push(old);
  const t0 = Date.parse('2026-11-27T10:00:00Z');
  await api.addLocations(phone, [{ provider: 'gps', lat: 52.37, lon: 4.89, accuracy: 8, bat: 81, date: t0 }, { provider: 'gps', lat: 52.38, lon: 4.9, accuracy: 6, bat: 80, date: t0 + 60_000 }]);
  await api.addLocations(tag, [{ provider: 'ble', lat: 52.371, lon: 4.891, accuracy: 15, bat: -1, date: t0 + 90_000, seenBy: phone.username, rssi: -70 }]);
  await api.addDevice(owner, { username: phone.username, pwk64: b64(phone.pwk), name: 'Fairphone', type: 'phone' });
  await api.addDevice(owner, { username: tag.username, pwk64: b64(tag.pwk), name: 'Sleutels', type: 'tag', tag: { kind: 'mac', id: 'AA:BB:CC:DD:EE:FF' } });
  await api.addDevice(owner, { username: old.username, pwk64: b64(crypto.randomBytes(32)), name: 'Oud', type: 'laptop' }); // stale key → 403
  const r = spawnSync(process.env.HOME + '/.cargo/bin/cargo', ['test', '-j', '2', 'sync_against_test_server', '--', '--ignored'], {
    cwd: new URL('../desktop', import.meta.url).pathname, encoding: 'utf8',
    env: { ...process.env, QF_TEST_SERVER: base, QF_TEST_OWNER: owner.username, QF_TEST_PWK64: b64(owner.pwk), QF_TEST_PHONE: phone.username },
  });
  console.log((r.stdout + r.stderr).split('\n').filter((l) => /^test |test result|panicked|error/.test(l)).join('\n'));
  assert.equal(r.status, 0, 'cargo test failed');
  console.log('ok  desktop-sync ziet telefoon, tag (gezien door telefoon) en weigert de oude sleutel één keer');
} finally {
  for (const s of created.reverse()) await api.deleteAccount(s).catch((e) => console.error('opruimen mislukt:', e.message));
  console.log(`opgeruimd: ${created.length} accounts`);
}
