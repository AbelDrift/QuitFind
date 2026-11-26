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
