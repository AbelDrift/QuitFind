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
