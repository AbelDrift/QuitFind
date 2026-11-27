// Browser test of the QuitFind owner dashboard (server/web) against the TEST server
// (default http://127.0.0.1:8096, never the real FMD). Start it with tests/web/run_dashboard_browser.sh:
// that serves server/web/dist through the test container and starts headless Firefox (WebDriver BiDi,
// no npm packages; like AlphaMaker/tests/web/browser_smoke.mjs). The UI language is Dutch (nl).
// 1. Node creates an owner (+ settings item), a phone, a laptop and a tag with locations.
// 2. Firefox logs in as the owner: the list shows the 3 names and the map 3 markers; the tag says
//    "gezien door Fairphone"; track + period filter; a command to the phone (checked with the phone's
//    keys); add a tag, edit and remove a device (checked in the register with Node).
// 3. A new owner account is created on the login page; Node logs in to it with the password.
// 4. A normal device account still gets the single-device view.
// All accounts are deleted at the end. Usage: node tests/web/dashboard_browser.mjs [baseUrl]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, b64, unb64, encItem, decRaw } from '../quitfind_v2.mjs';

const base = (process.argv[2] || 'http://127.0.0.1:8096').replace(/\/$/, '');
assert.ok(!/:8090|:8443|debian\./.test(base), 'refusing to run against the real FMD server');
const cfg = readFileSync(new URL('../../test-instance/config.yml', import.meta.url), 'utf8');
const regToken = /RegistrationToken:\s*"([^"]*)"/.exec(cfg)?.[1] ?? '';
const api = new Client(base), rnd = () => crypto.randomBytes(8).toString('hex');
const J = JSON.stringify, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const created = [];  // sessions to delete at the end

// ---- WebDriver BiDi ----
const ws = new WebSocket(`ws://127.0.0.1:${process.env.BIDI_PORT || 9334}/session`);
let seq = 0;
const pending = new Map(), logs = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'log.entryAdded') logs.push(`${m.params.level}: ${m.params.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++seq;
  pending.set(n, (m) => m.type === 'error' ? rej(new Error(`${method}: ${m.error} ${m.message}`)) : res(m.result));
  ws.send(JSON.stringify({ id: n, method, params }));
});
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no Firefox on the BiDi port')); });
await send('session.new', { capabilities: {} });
const { contexts: [{ context }] } = await send('browsingContext.getTree');
await send('session.subscribe', { events: ['log.entryAdded'] });

// In-page helpers. fill() works like typing: React listens to the native input/change events.
const HELPERS = `
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const fill = (el, v) => {
    if (typeof el === 'string') el = $(el);
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const button = (text) => $$('button').find((b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
  const device = (username) => $('[data-device="' + username + '"]');`;
const run = async (body) => {
  const r = await send('script.evaluate', {
    expression: `(async () => { ${HELPERS}\n${body} })()`, target: { context }, awaitPromise: true, resultOwnership: 'none',
  });
  if (r.type === 'exception') throw new Error(`in de pagina: ${r.exceptionDetails.text}`);
  return r.result?.value;
};
const waitFor = async (what, cond, ms = 60_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(300)) {
    if (await run(`return !!(${cond});`).catch(() => false)) return;
  }
  throw new Error(`time-out: ${what}`);
};
const open = async () => {
  await send('browsingContext.navigate', { context, url: base + '/', wait: 'complete' });
  await waitFor('aanmeldpagina', `$('input[autocomplete=username]')`);
};
const login = async (username, password) => {
  await open();
  await run(`fill('input[autocomplete=username]', ${J(username)});
    fill('input[autocomplete=current-password]', ${J(password)}); $('form button[type=submit]').click();`);
};
const register = async (owner) => (await api.register_(owner)).filter((e) => e.kind === 'device');

try {
  // 1. test data (one Argon2 run per account, one after another)
  const ownerPw = `eigenaar-${rnd()}`, phonePw = `telefoon-${rnd()}`;
  const owner = await api.register(`qf-owner-${rnd()}`, ownerPw, regToken); created.push(owner);
  const phone = await api.register(`qf-phone-${rnd()}`, phonePw, regToken); created.push(phone);
  const laptop = await api.register(`qf-laptop-${rnd()}`, `laptop-${rnd()}`, regToken); created.push(laptop);
  const tag = await api.register(`t-${rnd()}`, crypto.randomBytes(24).toString('base64'), regToken); created.push(tag);
  await api.postData(owner, 'device', [encItem(owner.keks.device, 'device', owner.username, { v: 1, kind: 'settings', registrationToken: regToken })]);
  await api.addDevice(owner, { username: phone.username, pwk64: b64(phone.pwk), name: 'Fairphone', type: 'phone' });
  await api.addDevice(owner, { username: laptop.username, pwk64: b64(laptop.pwk), name: 'Werklaptop', type: 'laptop' });
  await api.addDevice(owner, { username: tag.username, pwk64: b64(tag.pwk), name: 'Sleutels', type: 'tag', tag: { kind: 'mac', id: 'AA:BB:CC:DD:EE:FF' } });
  const now = Date.now();
  await api.addLocations(phone, [
    { provider: 'gps', lat: 52.3702, lon: 4.8952, accuracy: 8, bat: 81, date: now - 3 * HOUR, heading: 90 },
    { provider: 'gps', lat: 52.3710, lon: 4.8960, accuracy: 6, bat: 80, date: now - 10 * MIN },
  ]);
  await api.addLocations(laptop, [{ provider: 'network', lat: 52.0907, lon: 5.1214, accuracy: 30, bat: 55, date: now - 2 * DAY }]);
  await api.addLocations(await api.login(tag.username, { pwk: tag.pwk }), [
    { provider: 'ble', lat: 52.3709, lon: 4.8961, accuracy: 15, bat: -1, date: now - 5 * MIN, seenBy: phone.username, rssi: -71 },
  ]);
  console.log('ok  testgegevens: eigenaar met telefoon, laptop en tag (met locaties)');

  // 2. the dashboard of the owner
  await login(owner.username, ownerPw);
  await waitFor('3 apparaten in de lijst', `$$('#device-list li').length === 3`);
  const names = JSON.parse(await run(`return JSON.stringify($$('#device-list li .truncate').map((e) => e.textContent).sort());`));
  assert.deepEqual(names, ['Fairphone', 'Sleutels', 'Werklaptop']);
  await waitFor('3 markers op de kaart', `$$('#devices-map .leaflet-marker-icon').length === 3`);
  console.log(`ok  lijst: ${names.join(', ')}; 3 markers op de kaart`);
  await waitFor('tag "gezien door Fairphone"', `device(${J(tag.username)}).textContent.includes('gezien door Fairphone')`);
  console.log('ok  tag: "gezien door Fairphone"');
  const shot = async (name) => {
    if (!process.env.SHOT_DIR) return;
    await waitFor('kaarttegels', `$$('.leaflet-tile-loaded').length > 0`, 8000).catch(() => {});
    const { data } = await send('browsingContext.captureScreenshot', { context });
    writeFileSync(`${process.env.SHOT_DIR}/${name}.png`, Buffer.from(data, 'base64'));
  };
  await shot('dashboard');

  await run(`device(${J(phone.username)}).querySelector('button').click();`);
  await waitFor('spoor van de telefoon (lijn + 2 punten)', `$$('#devices-map path.leaflet-interactive').length === 3`);
  await shot('dashboard-telefoon');
  await run(`device(${J(laptop.username)}).querySelector('button').click();`);
  await waitFor('laptop: niets in 24 uur', `document.body.textContent.includes('0 locaties in deze periode')`);
  await run(`button('7 dagen').click();`);
  await waitFor('laptop: 1 locatie in 7 dagen', `document.body.textContent.includes('1 locatie in deze periode')`);
  console.log('ok  spoor en filter (24 uur / 7 dagen)');

  // a command for the phone goes through the phone's own session and keys
  const LOCATE_ALL = 'Een locatie verkrijgen van alle locatieleveranciers';
  await run(`device(${J(phone.username)}).querySelector('button').click();`);
  await waitFor('opdrachten van de telefoon', `$$('button').some((b) => b.textContent.includes(${J(LOCATE_ALL)}))`);
  await run(`$$('button').find((b) => b.textContent.includes(${J(LOCATE_ALL)})).click();`);
  let commands = [];
  for (let i = 0; i < 50 && !commands.length; i++) {
    commands = await api.getData(phone, 'command');
    if (!commands.length) await sleep(200);
  }
  assert.equal(commands.length, 1);
  assert.equal(decRaw(phone.keks.command, 'command', phone.username, commands[0]).toString('utf8'), 'locate all');
  console.log('ok  opdracht "locate all" versleuteld met de sleutel van de telefoon');

  // manage: add a tag (its account is created in the browser), edit, remove
  await run(`button('Tag toevoegen').click();`);
  await waitFor('tag-dialoog', `$('#tag-id')`);
  assert.equal(await run(`return !!$('#tag-registration-token');`), false, 'het token komt uit het settings-item');
  await run(`fill('#device-name', 'Rugzak'); fill('#tag-id', '11:22:33:44:55:66'); $('#device-form button[type=submit]').click();`);
  await waitFor('4 apparaten na "Tag toevoegen"', `$$('#device-list li').length === 4 && !$('#device-form')`, 90_000);
  const rugzak = (await register(owner)).find((e) => e.name === 'Rugzak');
  assert.ok(rugzak && /^t-[0-9a-f]{16}$/.test(rugzak.username) && rugzak.type === 'tag', J(rugzak));
  assert.deepEqual(rugzak.tag, { kind: 'mac', id: '11:22:33:44:55:66' });
  created.push(await api.login(rugzak.username, { pwk: unb64(rugzak.pwk64) }));  // the stored K_pwk works
  console.log(`ok  tag toegevoegd in de browser (${rugzak.username}); inloggen met de opgeslagen sleutel werkt`);

  await run(`device(${J(laptop.username)}).querySelector('button').click();`);
  await waitFor('laptop geselecteerd', `$('h2')?.textContent === 'Werklaptop'`);
  await run(`button('Bewerken').click();`);
  await waitFor('bewerk-dialoog', `$('#device-type')`);
  await run(`fill('#device-name', 'Laptop thuis'); fill('#device-type', 'pc'); $('#device-form button[type=submit]').click();`);
  await waitFor('nieuwe naam in de lijst', `device(${J(laptop.username)}).textContent.includes('Laptop thuis') && !$('#device-form')`);
  const lap = (await register(owner)).filter((e) => e.username === laptop.username);
  assert.equal(lap.length, 1, 'het oude item is weg');
  assert.equal(lap[0].name, 'Laptop thuis');
  assert.equal(lap[0].type, 'pc');
  assert.equal(lap[0].pwk64, b64(laptop.pwk));
  console.log('ok  bewerkt: één item met nieuwe naam en soort');

  await run(`device(${J(rugzak.username)}).querySelector('button').click();`);
  await waitFor('rugzak geselecteerd', `$('h2')?.textContent === 'Rugzak'`);
  await run(`button('Verwijderen').click();`);
  await waitFor('bevestigingsvenster', `$('[role=dialog]')`);
  await run(`$$('[role=dialog] button').find((b) => b.textContent.trim() === 'Verwijderen').click();`);
  await waitFor('3 apparaten na verwijderen', `$$('#device-list li').length === 3`);
  assert.equal((await register(owner)).length, 3);
  console.log('ok  verwijderd uit het register');

  // a stale key (password changed on the device) is shown and not retried: 7 failed logins would lock
  // the account for 10 minutes, also for the device itself
  const stale = await api.register(`qf-tablet-${rnd()}`, `tablet-${rnd()}`, regToken); created.push(stale);
  await api.addDevice(owner, { username: stale.username, pwk64: b64(crypto.randomBytes(32)), name: 'Oude tablet', type: 'tablet' });
  await login(owner.username, ownerPw);
  await waitFor('melding bij de verouderde sleutel', `device(${J(stale.username)})?.textContent.includes('sleutel wordt geweigerd')`);
  for (let i = 0; i < 8; i++) { await run(`button('Vernieuwen').click();`); await sleep(400); }
  await api.login(stale.username, { pwk: stale.pwk });  // 423 here if the dashboard had kept trying
  console.log('ok  verouderde sleutel: melding, geen herhaalde logins (account niet geblokkeerd)');

  // 3. a new owner account on the login page (registration in the browser)
  const owner2 = `qf-owner2-${rnd()}`, owner2Pw = `nieuw-${rnd()}`;
  await open();
  await run(`$('#toggle-register').click();`);
  await waitFor('registratievelden', `$('#registration-token')`);
  await run(`fill('input[autocomplete=username]', ${J(owner2)});
    const [a, b] = $$('input[autocomplete=new-password]'); fill(a, ${J(owner2Pw)}); fill(b, ${J(owner2Pw)});
    fill('#registration-token', ${J(regToken)}); $('form button[type=submit]').click();`);
  await waitFor('leeg dashboard van het nieuwe account', `$('#device-list') && document.body.textContent.includes('Geen apparaten')`, 90_000);
  const o2 = await api.login(owner2, { password: owner2Pw }); created.push(o2); // geheimen-check: ok
  assert.deepEqual((await api.register_(o2)).map(({ id, ...e }) => e), [{ v: 1, kind: 'settings', registrationToken: regToken }]);
  console.log('ok  eigenaar-account aangemaakt in de browser; Node logt in met het wachtwoord en leest het register');

  // 4. a normal device account keeps the upstream single-device view
  await login(phone.username, phonePw);
  await waitFor('enkel-apparaatweergave', `!$('#device-list') && $$('.leaflet-marker-icon').length >= 1 && document.body.textContent.includes('80%')`, 90_000);
  console.log('ok  gewoon apparaat-account: enkel-apparaatweergave');
  console.log('GESLAAGD');
} finally {
  for (const s of created.reverse()) {
    await api.deleteAccount(s)
      .catch(() => api.login(s.username, { pwk: s.pwk }).then((fresh) => api.deleteAccount(fresh)))
      .catch((e) => console.error('opruimen mislukt:', s.username, e.message));
  }
  console.log(`opgeruimd: ${created.length} accounts`);
  const errors = logs.filter((l) => /^error/.test(l));
  console.log(errors.length ? `console-fouten van de pagina:\n  ${errors.join('\n  ')}` : 'console: geen fouten');
  await send('session.end').catch(() => {});
  ws.close();
}
