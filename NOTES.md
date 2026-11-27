# QuitFind – logboek (herstelpunt)

## Plan in fasen
0. **Opzet** – map, licentie, repo's (GitHub + Codeberg). ← nu
1. **Fork server** – FMD-server (Go) forken op dezelfde versie als nu (0.17.1), bouwen,
   naast de bestaande draaien op een testpoort; bestaande Fairphone-koppeling blijft werken.
2. **Apparaatsoorten + kaart** – in de server: soorten (telefoon, tablet, laptop, pc, tag),
   één kaart met alle apparaten, locatiegeschiedenis per apparaat.
3. **Android-app** – fork FMD-android: kaart (OpenStreetMap) met alle apparaten en de
   bediening van de webpagina; daarna Bluetooth-tags scannen en "tag X gezien op plek Y"
   naar de server sturen.
4. **Desktop** – Rust/egui-app uit Craft Anything koppelen aan de server (laptop/pc als
   apparaat, tags scannen, kaart).
5. **QuitSuite** – later één account/inlog met QuitChat en QuitCloud.

## Besluiten
- 2026-11-26: naam QuitFind; openbaar op GitHub en Codeberg; GPL-3.0 (FMD-fork).
- Tags worden alleen door eigen apparaten gevonden (geen crowd-netwerk; dat van Google/Apple
  is gesloten). Uitgelegd aan Abel.
- Android-app krijgt een echte kaart in de app (niet alleen de webpagina in een WebView).

## Logboek
- 2026-11-26: map ~/claude/QuitFind aangemaakt (CLAUDE.md, README, LICENSE, NOTES). Wacht op
  lege repo's AbelDrift/QuitFind op GitHub en Codeberg (Abel maakt ze aan, geen gh-cli hier).
- 2026-11-26: repo's bestaan; opzet gepusht (e7322dd). Abel: Google-brug als OPTIE in instellingen,
  beide manieren: A = op de server via een open project dat met eigen account tag-locaties bij
  Google ophaalt (eerst code+licentie nalezen; reserve-Google-account i.v.m. blokkaderisico);
  B = reservetelefoon met Find Hub + hulp-app die locatie doorstuurt (breekbaar). Standaard uit.
  Fase 3b in het plan. Abel heeft e/OS (Murena) op de Fairphone met microG → uitzoeken of microG
  de Find Hub-netwerkfunctie ondersteunt (dan kan de Fairphone ook tags van anderen/zichzelf melden).
- Fase 1 gestart: FMD-server v0.17.1 via `git subtree add --prefix server … v0.17.1 --squash`
  (updates later: `git subtree pull --prefix server https://gitlab.com/fmd-foss/fmd-server.git <tag> --squash`).
  Go staat niet op de pc → bouwen met Docker: image quitfind-server:dev.
- 2026-11-26 22:04: FASE 1 OK: image quitfind-server:dev (349 MB) gebouwd; testserver via test-instance/docker-compose.yml (container quitfind-test, 127.0.0.1:8096→8080, read_only, cap_drop ALL, 512 MB, eigen lege db). Web 200, /api/v1/version = 0.17.1. Starten: cd test-instance && docker compose up -d.
- 2026-11-26 22:05: workflow quitfind-begrijpen (run wf_bb5605f6-552): 8 lezers (server-api, web, crypto, android, tags, bridge, desktop, suite) → architect-bouwplan. Hervatten: Workflow scriptPath ~/.claude/projects/-home-abel-claude-algemeen/63eeee7a-6517-415a-ba3c-8a163a78d5ff/workflows/scripts/quitfind-begrijpen-wf_bb5605f6-552.js + resumeFromRunId wf_bb5605f6-552. Goal van Abel: doorwerken tot de app klaar lijkt of het tegoed op is.
- 2026-11-26: android/ = FMD-android v0.17.1 via `git subtree add --prefix android https://gitlab.com/fmd-foss/fmd-android.git v0.17.1 --squash` (5,3 MB). desktop/ = broncode (src, Cargo.toml, Cargo.lock) gekopieerd uit Craft Anything (clean room, eigen code van Abel; target/ en shots/ niet meegenomen).
- 2026-11-26 22:12: Android-basisbouw OK: assembleDevDebug in 5m20s → android/app/build/outputs/apk/dev/debug/app-dev-debug.apk. Bouwen: cd android && JAVA_HOME=~/.local/opt/jdk-21.0.13+9 ANDROID_HOME=~/ontwikkeling/android-sdk systemd-run --user --scope -q -p MemoryMax=3500M -p MemorySwapMax=0 nice -n 10 ./gradlew --no-daemon --console=plain -Dorg.gradle.jvmargs=-Xmx1536m -Pkotlin.compiler.execution.strategy=in-process assembleDevDebug (Gradle 9.5.1, compileSdk 37, Java 21, Compose; applicationId de.nulide.findmydevice → later eigen id).

## Ontwerp (2026-11-27, na onderzoek server-api/web/crypto/android)
- Eén FMD-account per apparaat (upstream-compatibel) + één EIGENAAR-account met versleuteld
  apparatenregister (nieuw datatype `device`, nooit opgeschoond). Formaat: docs/apparatenregister.md
  (K_kek_device = HKDF(K_master, "quitfind_v1_kek_device"||SHA256(naam)); items met pwk64 zodat
  apps zonder Argon2 per apparaat kunnen inloggen).
- Tags = eigen FMD-account per tag (naam t-<16 hex>); telefoon/laptop/brug loggen in met de pwk
  van de tag en posten een gewone versleutelde locatie (provider "ble"/"google", extra velden
  seenBy, rssi). Geen tag-specifieke servercode nodig.
- Alleen protocol v2 (v1-accounts: doorverwijzen naar de migratie-wizard van FMD Android).
- Sessies: altijd 1 week aanvragen; bij 401 opnieuw inloggen met opgeslagen pwk (server vergeet
  tokens bij herstart). Logins nooit parallel (Argon2 128 MiB).
- Web: dashboard naast de bestaande enkel-apparaatweergave; geen geneste routes (relatieve paden).
  Bekende upstream-bugs meenemen: heading vs bearing, LocationMap.tsx:179 index-guard, export
  met loc.time.
- Server-wijziging fase 2: user/data_type.go (DataTypeDevice=3, KEEP_ALL), metrics.DeviceEntries,
  user_metrics.go, openapi enum + user/data_type_test.go. Tests via `docker build --target builder`
  + `docker run --network none quitfind-server:builder go test ./user/ ./backend/`.
- Node-client tests/quitfind_v2.mjs + e2e tests/e2e_register.mjs (alleen tegen :8096; ruimt op).
- 2026-11-27 07:27: image met datatype device gebouwd, Go-tests ok (user, backend); testserver herstart; e2e_register.mjs SLAAGT (4 accounts, register, tagwaarneming via telefoon, verse client ziet alles, manipulatie geweigerd, opgeruimd). Workflow quitfind-dashboard (run wf_48eeefa5-91f): bouwer → 3 reviewers → verificatie → hersteller. Hervatten: Workflow scriptPath ~/.claude/projects/-home-abel-claude-algemeen/63eeee7a-6517-415a-ba3c-8a163a78d5ff/workflows/scripts/quitfind-dashboard-wf_48eeefa5-91f.js + resumeFromRunId wf_48eeefa5-91f.
- 2026-11-27 12:55: WEB-DASHBOARD (bouwer van wf_48eeefa5-91f) KLAAR EN GETEST, nog niet gecommit.
  - Na inloggen leest Home het register (GET api/v2/data/device, lib/owner.ts loadRegister). Met items
    (ook alleen het settings-item) → OwnerDashboard: één kaart met de laatste locatie per apparaat
    (icoon per soort, naam als label; tag-label onder de pin), lijst (naam, soort, laatst gezien,
    batterij, provider, "gezien door <naam>"), gekozen apparaat → spoor op datum + filter 24 uur/
    7 dagen/alles, opdrachten via DeviceCommands met de sessie van dat apparaat (niet bij tags).
    Beheer (modals/DeviceDialog.tsx): Apparaat toevoegen (Argon2 1×, inlogcontrole, pwk64 bewaren),
    Tag toevoegen (account t-<16 hex>, willekeurig wachtwoord, token uit settings-item of 1× vragen),
    bewerken (nieuw item, oude weg), verwijderen (alleen uit register). Gewone accounts: ongewijzigd.
    Inlogpagina: "Nieuw eigenaar-account" (registratie in de browser + settings-item met token).
  - Code: server/web/src/lib/owner.ts (register, sessies, beheer), lib/hashWorker.ts (gedeelde
    Argon2-worker), apiv2.ts (loginV2, ApiV2Service met sessie per apparaat, 401 → opnieuw inloggen),
    cryptov2.ts (K_kek_device, encryptNewMasterKey), api.ts (requestV2 met eigen token, 401 logt de
    eigenaar dan niet uit), components/OwnerDashboard.tsx, DevicesMap.tsx, DevicePanel.tsx
    (DeviceCommands los), PhotosModal (optioneel api), Home, LoginForm; teksten nl+en.
    pwk's alleen in het geheugen; deviceKek niet-exporteerbaar (ook in IndexedDB); oude opgeslagen
    sleutels zonder deviceKek → eenmalig opnieuw inloggen.
  - Upstream-bugs opgelost: heading ?? bearing (popup + export), LocationMap index-guard, export met
    loc.date i.p.v. loc.time.
  - INLOG-BLOKKADE: de server blokkeert een account 10 min na 7 mislukte logins. Het dashboard
    probeert een apparaat-login na 403/404/423 niet opnieuw (melding "sleutel geweigerd ... opnieuw
    koppelen"). Android/desktop moeten dat ook doen (staat in docs/apparatenregister.md).
  - Bouwen: cd server/web && systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=0
    nice -n 10 npx --offline corepack pnpm run build (tsc + vite; corepack staat niet globaal, npx
    haalt hem uit de cache). ESLint draait NIET: typescript-eslint 8.72 weigert TypeScript 7.0
    (upstream-probleem, ook zonder deze wijziging); prettier --check op de gewijzigde bestanden ok.
  - UI testen zonder het Go-image te herbouwen: override tests/web/docker-compose.web.yml
    (FMD_WEBDIR=/srv/web + server/web/dist read-only gemount; test-instance/ staat in .gitignore,
    daarom in tests/web). De testcontainer quitfind-test draait nu zo en serveert steeds de verse
    dist (overleeft herbouwen). Terug naar de ingebouwde UI: docker compose -f
    test-instance/docker-compose.yml up -d. De echte FMD (:8090/:8443) is niet aangeraakt.
  - Browsertest: tests/web/run_dashboard_browser.sh (zet de override aan, headless Firefox onder
    MemoryMax=2500M, BiDi-poort 9334, UI in het Nederlands; screenshot met SHOT_DIR=map) →
    tests/web/dashboard_browser.mjs: GESLAAGD (3 namen, 3 markers, "gezien door", spoor+filter,
    opdracht met sleutel van de telefoon, tag toevoegen/bewerken/verwijderen, verouderde sleutel niet
    herhaald, eigenaar-account aangemaakt in de browser en door Node ingelogd, gewoon account →
    enkel-apparaatweergave; alles opgeruimd). Mutatiecheck: zonder de blokkade-fix faalt hij (423).
    tests/e2e_register.mjs slaagt nog (quitfind_v2.mjs kreeg decRaw voor opdrachten).
  - Open: (1) het Go-image bevat nog de oude ingebouwde UI → docker build nodig vóór gebruik zonder
    override; (2) "Account verwijderen" in Instellingen verwijdert bij een eigenaar alleen het
    eigenaar-account: apparaat-accounts blijven, tag-accounts worden onbereikbaar (geen waarschuwing);
    (3) tag uit register verwijderen laat het tag-account onbereikbaar op de server staan (besluit
    Abel: account dan ook verwijderen?); (4) andere talen dan nl/en tonen de nieuwe teksten in het
    Engels; (5) pinnen dicht op elkaar overlappen nog deels (geen clustering).

## Onderzoeksuitkomsten (workflow wf_bb5605f6-552; volledige rapporten in ~/.claude/projects/-home-abel-claude-algemeen/63eeee7a-6517-415a-ba3c-8a163a78d5ff/subagents/workflows/wf_bb5605f6-552/journal.jsonl)
Architect-stap mislukte (gebruikslimiet; maandelijkse bestedingslimiet bereikt; onderzoek kostte ~4 mln tokens) → plan door hoofdsessie.
- TAGS: Fresh 'n Rebel Find Hub-tags (6ATAG61 Google-only; 6ATAG72R Apple óf Google) zenden Eddystone 0xFEAA, frame 0x40/0x41,
  20-byte EID (secp160r1, r = AES-ECB-256(EIK, klok) mod n), EID+MAC wisselen ~1024 s. Zonder EIK: alleen "een Find Hub-tag in de buurt".
  Met EIK (eenmalig uit het Google-account, bv. via GoogleFindMyTools, GPL-3.0): lokaal herkennen, batterij lezen, laten piepen.
  Tags in Find Hub laten (anti-stalking + crowd). microG (e/OS 4.5.1, microG 0.3.17) doet NIET mee aan het Find Hub-netwerk.
  Vaste-ID-tags (iTag, iBeacon, Eddystone-UID) volledig zelf te volgen.
- BRUG A: sidecar-container P6g9YHK6/GoogleFindMyToolsWebUi (GPL-3.0), vastgepind op digest, alleen 127.0.0.1:4321, reserve-account;
  tags vanuit hoofdaccount delen met reserve-account. Eerste login eenmalig met Chrome + schermvergrendelings-PIN.
  Risico's: tokens ingetrokken / beveiligingswaarschuwingen; tags piepen soms willekeurig bij pollen (ook FnR). Ingest-adapter
  (OsmAnd-protocol → tag-accounts). Reserve: traccar/google-find-hub-sync (+FCM-fix) of mheers/google-find-my-tools-go.
- BRUG B: reservetelefoon met Find Hub; meeste varianten (meldingen, schermuitlezen) afgeraden: breekbaar.
- DESKTOP: crate findhub-desktop (Rust 2024, eframe/egui 0.37, walkers 0.66, zbus 5); BLE via BlueZ/D-Bus; eigen HTTP-server
  op 0.0.0.0:8765 (→ naar 127.0.0.1!); ~/.config/open-find/devices.json. Plan: src/fmd.rs ~300 regels (argon2 0.5, hkdf 0.12,
  aes-gcm 0.10.3; reqwest blocking in eigen thread).
- SUITE (QuitChat-conventies): appId org.codeberg.abeldrift.quitfind; logo navy #17324D + oranje #FFB547 (Q met oranje staart);
  docs/commits Nederlands, UI meertalig (en sjabloon, nl vertaling); bouwen.sh/sleutel-maken.sh, sleutel buiten repo
  (~/ontwikkeling/quitfind-sleutel); serveradres buiten de bron (bij bouwen ingeven); geheimen-check vóór commit (nu ingebouwd).
- PRIVACY: Tailscale-hostnaam stond in CLAUDE.md (openbaar, sinds e7322dd). Nu vervangen; echte adressen in LOKAAL.md (genegeerd).
  Staat nog in de git-geschiedenis: herschrijven is Abels keuze (alleen bereikbaar binnen de tailnet).
- 2026-11-27 (avond): DASHBOARD GEBOUWD (workflow wf_48eeefa5-91f, bouwer): eigenaar-modus (register → alle apparaten op één
  kaart met icoon per soort, lijst met laatst gezien/batterij/provider/"gezien door", spoor + filter 24u/7d/alles, opdrachten per
  apparaat), apparaat koppelen, tag toevoegen/bewerken/verwijderen, nieuw eigenaar-account op de inlogpagina, upstream-fixes
  (heading??bearing, index-guard, export loc.date), lockout-bescherming (geen herhaalde login na 403/404/423).
  Tests: pnpm build ok; tests/web/run_dashboard_browser.sh (headless Firefox, ruimt op) ok; e2e_register ok.
  Testserver serveert server/web/dist via tests/web/docker-compose.web.yml (terug: docker compose -f test-instance/docker-compose.yml up -d).
  Kosten: dashboard-workflow ~3,6 mln tokens, onderzoek ~4 mln; maandelijkse bestedingslimiet bereikt, week 80% (27 nov).
  OPEN REVIEWPUNTEN (bevestigd = B, onbevestigd = ?):
  B medium OwnerDashboard.tsx:60/:? één misvormde (ontsleutelde) locatie laat het hele dashboard crashen → velden valideren
  B medium PhotosModal.tsx:47 foto's van apparaat A verschijnen bij B (gedeelde store-pictures, late antwoorden)
  B medium Home.tsx:153 instellingen in eigenaar-modus wissen/exporteren alleen het lege eigenaar-account maar melden succes
  B low/med owner.ts:113 blokkadebescherming alleen per paginasessie (herladen telt opnieuw); 423 als blijvend behandeld
  B low dashboard_browser.mjs:150 test ruimt browser-accounts niet op bij falen halverwege
  ? medium DevicesMap.tsx:157 kaart kent krimpende container niet (<1024px spoor buiten beeld) → invalidateSize/ResizeObserver
  ? low owner.ts:169 mislukte eerste registerlezing → stil enkel-apparaatweergave; owner.ts:319 beheer herlaadt register niet na
    halve mislukking; owner.ts:85 vastgelopen Argon2-worker; DevicesMap.tsx:87 kaartlaag steeds herbouwd (popups sluiten);
    LoginForm.tsx:60 Engelse serverfouten; DeviceDialog.tsx:138 velden zonder zichtbaar label; OwnerDashboard.tsx:32 elke 60 s
    volledige geschiedenis van elk apparaat ophalen.
  Weerlegd: owner.ts:110 (veld server genegeerd: niemand schrijft het), OwnerDashboard.tsx:60 (variant zonder schrijver).
- 2026-11-27 (avond): 4 bevestigde medium-punten OPGELOST (hoofdsessie): ongeldige locaties gefilterd (isValidLocation),
  geweigerde logins bewaard over herladen heen (localStorage 'quitfind-refused', gehashte sleutel; 423 pas na 10 min opnieuw),
  foto's per apparaat (store leeg bij openen, late antwoorden genegeerd), instellingen in eigenaar-modus verbergen
  export/wis-knoppen met uitleg. Browsertest + e2e opnieuw groen. Nog open: DevicesMap invalidateSize (<1024px) en de low-punten hierboven.
- 2026-11-27 (avond): FASE 3 begonnen (Android, package de.nulide.findmydevice.quitfind, upstream-bestanden onaangeroerd): QfCrypto (device-KEK, open datatypen, pwk-login), QfApi (OkHttp+Gson v2-client, niet-singleton), QfRegister (register + locaties, misvormde items overslaan). Tests: QfCryptoTest 4/4 (Node-vector V6 in tests/fmd_v2_vectors.mjs), QfServerIT 1/1 tegen :8096 (QF_TEST_REGTOKEN). Draaien: zie gradle-regel hierboven + 'testDevDebugUnitTest --tests de.nulide.findmydevice.quitfind.*' met -E QF_TEST_REGTOKEN=…
- 2026-11-27 (avond): Android-kaarttab gebouwd: QfMapFragment (Compose + osmdroid 6.1.20, eerste/standaard tab 'Kaart'), QfMapViewModel (eigenaar koppelen met wachtwoord → pwk in EncryptedSharedPreferences 'quitfind_owner', uitgesloten van back-ups; apparaten sequentieel inloggen met pwk, 401 → één keer opnieuw, 403/404/423 → niet opnieuw tot ontkoppelen), lijst met laatst gezien/batterij/provider/gezien door, spoor 24 u van gekozen apparaat. applicationId org.codeberg.abeldrift.quitfind (dev: .dev), app_name QuitFind, strings en/nl. assembleDevDebug OK (28 MB), QfCryptoTest 4/4 + QfServerIT 1/1. NIET getest op een toestel/emulator (geen emulator op deze pc).
- 2026-11-27 (avond): Android TAGS: QfTagMatcher (mac / ibeacon uuid:major:minor / eddystone 32 hex; fmdn nog niet: EIK nodig), QfTagScanWorker (WorkManager elke 15 min, 10 s scan MET filters (scherm uit), locatie via getCurrentLocation/lastKnown ≤10 min, per tag inloggen met pwk en versleutelde locatie {provider ble, seenBy eigen FMD-id, rssi}; 403/404 → tag niet meer proberen), schakelaar in kaarttab (vraagt FINE_LOCATION + BLUETOOTH_SCAN), BLUETOOTH_SCAN zonder neverForLocation. Tests: QfTagMatcherTest 3/3 + eerdere 5/5; build OK. Op toestel nog niet getest.
- 2026-11-27 (avond): web tag-dialoog: voorbeeld per soort (mac/ibeacon/eddystone/fmdn) + dezelfde vormcontrole als Android (isValidTagId in lib/owner.ts ↔ QfTagMatcher.identityOf). Browsertest groen.
- 2026-11-27 (avond): FASE 4 (desktop, Rust): src/fmd.rs (FMD v2-crypto met argon2/hkdf/aes-gcm, reqwest blocking, link() met één Argon2, sync() met onthouden geweigerde sleutels), core.rs sync-thread elke 60 s → apparaten 'qf:<account>' in de bestaande lijst/kaart (soort, spoor ≤200, batterij, 'seen by <naam>'), kaartje 'QuitFind server' in tab Connect (koppelen/ontkoppelen), instellingenbestand nu 0600 (bevat sleutels). Tests: cargo test fmd:: 3/3 (Node-vectoren) + tests/desktop_sync.mjs (Rust-sync tegen :8096) OK. Mini-server blijft op 0.0.0.0:8765 (met sleutel; bedoeld voor telefoons op het thuisnetwerk).
- 2026-11-27 (avond): image quitfind-server:dev opnieuw gebouwd MET het dashboard ingebouwd (geserveerde JS bevat quitfind_v1_kek_device); testcontainer draait weer zonder web-bind-mount; e2e OK. README bijgewerkt (stand, gebruik, eerlijk over tags, tests) + docs/docker-compose.example.yml. STAND: eerste versie van alle onderdelen klaar. Nog open (vraagt Abel): APK op de Fairphone testen (adb install app-dev-debug.apk), echte server overzetten (back-up db eerst!), Google-brug A (reserve-account, eenmalig Chrome-login), FMDN/Fresh 'n Rebel (EIK via brug), release-sleutel + app-icoon QuitSuite-stijl, open low-reviewpunten dashboard.
- 2026-11-27 (avond): GOOGLE-BRUG A: adapter bridge/google/ingest.mjs (OsmAnd GET/POST → sleutel (timingSafeEqual), invoercontrole, register-instelling googleBridge='server', tag in register, dubbel overslaan, geweigerde sleutel onthouden → versleutelde locatie provider 'google' + status). tests/bridge_ingest.mjs OK (geen Google nodig). Web: Instellingen (eigenaar) → Google-brug uit / A server / B telefoon (B nog niet gebouwd). LEESMIJ.md + docker-compose.yml = SJABLOON (sidecar nog niet gedraaid; vastpinnen op digest). Node-client verhuisd naar lib/quitfind_v2.mjs (tests/ her-exporteert).
- 2026-11-27 (avond): dashboard low-punten: kaart volgt containergrootte (ResizeObserver → invalidateSize), tijdelijke fout bij eerste registerlezing → tot 3× opnieuw i.p.v. stil enkel-apparaatweergave (oude server zonder 'device' → wel enkelweergave), Argon2-worker na 2 min afgebroken, zichtbare labels bij alle velden in het apparaatdialoog. Build + browsertest groen. LET OP: image quitfind-server:dev bevat nog de web-versie van vóór deze punten + Google-brug-instelling → opnieuw bouwen vóór gebruik (cd server && docker build -t quitfind-server:dev .). Nog open (low): kaartlaag herbouwd bij elke wijziging (popups sluiten), Engelse serverfouten in NL-UI, 60 s volledige geschiedenis ophalen.
- 2026-11-27 (avond): QuitFind-icoon (QuitSuite-stijl: navy #17324D tegel, witte locatiespeld, oranje #FFB547 tag-stip): Android adaptief icoon (vector, main/dev/edge), web icon.svg + PNG-favicons (ImageMagick) + titel/manifest 'QuitFind'. Android build OK. Image moet nog één keer opnieuw (web-labels + icoon).
- 2026-11-27 (avond): android/bouwen.sh (debug/release, --installeren, serveradres uit ~/.config/quitfind/adres → -PquitfindServer) + android/sleutel-maken.sh (sleutel in ~/ontwikkeling/quitfind-sleutel, key.properties genegeerd) + signingConfig in app/build.gradle. Release-proefbouw met TIJDELIJKE sleutel: R8 OK, APK ondertekend (CN=QuitFind-proef), proefsleutel weer verwijderd. Echte sleutel NIET gemaakt (Abels keuze + back-up). Image opnieuw gebouwd (web met labels/icoon/Google-brug); testserver draait erop (titel QuitFind).

## STAND 27 nov 2026 (eind van de sessie) — hier verder lezen
Eerste complete versie, alles gepusht (laatste commit: zie git log). Alle tests groen:
`node tests/fmd_v2_vectors.mjs`, `node tests/e2e_register.mjs`, `node tests/bridge_ingest.mjs`, `node tests/desktop_sync.mjs`,
`tests/web/run_dashboard_browser.sh`, Android `testDevDebugUnitTest --tests 'de.nulide.findmydevice.quitfind.*'` (8 tests),
desktop `cargo test fmd::` (3). Testserver: `docker compose -f test-instance/docker-compose.yml up -d` (127.0.0.1:8096).
KLAAR: server (+datatype device), webdashboard (+Google-brug-instelling, icoon), Android (kaarttab, tags zoeken MAC/iBeacon/
Eddystone, icoon, bouwen.sh/sleutel-maken.sh), desktop (QuitFind-sync), Google-brug A-adapter (+LEESMIJ, compose-sjabloon).
WACHT OP ABEL: (1) APK op de Fairphone testen (`android/bouwen.sh --installeren`), (2) echte server overzetten (back-up db!),
(3) Google-brug A met reserve-account (eenmalige Chrome-login), (4) echte release-sleutel (`android/sleutel-maken.sh`),
(5) Tailscale-hostnaam uit git-geschiedenis halen of niet.
NOG TE DOEN (zelf): FMDN-tags lokaal herkennen met EIK (EID-berekening secp160r1; testvectoren nodig), Google-brug B (afgeraden),
low-punten dashboard (popups sluiten bij herbouw kaartlaag, Engelse serverfouten in NL, 60 s volledige geschiedenis),
desktop-UI visueel testen (geen Xvfb; niet op Abels scherm zonder vragen).
- 2026-11-27 (avond): echte release-sleutel gemaakt met android/sleutel-maken.sh → ~/ontwikkeling/quitfind-sleutel (700/600; key.properties genegeerd). ABEL: reservekopie maken van die map! Emulator wordt geïnstalleerd (emulator + system-images;android-35;default;x86_64) om de Android-UI echt te testen tegen :8096 (via 10.0.2.2).
