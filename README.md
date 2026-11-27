# QuitFind

Vind je telefoons, tablets, laptops en Bluetooth-tags terug via je eigen server – zonder Google.
QuitFind is een uitbreiding (fork) van [FMD – Find My Device](https://gitlab.com/fmd-foss) en
hoort bij **QuitSuite** (QuitChat, QuitFind en later QuitCloud).

> Stand (27 november 2026): eerste werkende versie van server, webpagina, Android-app en
> desktopapp, met tests. Nog niet op een echte telefoon uitgeprobeerd.

## Wat het kan
| onderdeel | wat |
|---|---|
| **server** (`server/`) | FMD-server 0.17.1 + versleuteld **apparatenregister** (datatype `device`). Gewone FMD-apps blijven werken. |
| **webpagina** | Inloggen met je **eigenaar-account** → al je apparaten op één kaart, met soort, laatst gezien, batterij, spoor (24 uur / 7 dagen / alles) en opdrachten (laten rinkelen, lokaliseren, foto, …). Apparaten koppelen, tags toevoegen, eigenaar-account aanmaken. |
| **Android-app** (`android/`) | Alles van FMD, plus een tab **Kaart** met al je apparaten (OpenStreetMap) en **je eigen tags zoeken**: elke 15 minuten kort Bluetooth, en een gevonden tag krijgt de locatie van de telefoon. Installeert naast de echte FMD-app (`org.codeberg.abeldrift.quitfind`). |
| **desktopapp** (`desktop/`) | Linux-app (Rust/egui) met kaart en Bluetooth-scanner; koppelt aan de server en toont al je QuitFind-apparaten. |

Hoe het werkt: elk apparaat (ook elke tag) is een eigen FMD-account. Een apart eigenaar-account bewaart
de lijst, end-to-end versleuteld; de server ziet alleen versleutelde gegevens. Zie
[docs/apparatenregister.md](docs/apparatenregister.md).

## Eerlijk over tags
Een goedkope Bluetooth-tag weet zelf niet waar hij is: hij roept alleen "ik ben tag X". De locatie komt
van het apparaat dat hem hoort. QuitFind gebruikt alleen **jouw eigen apparaten**, dus een tag wordt
gevonden als je telefoon (of laptop) in de buurt komt – niet als hij ergens in de stad ligt.
- **Werkt nu:** tags met een vaste ID: eenvoudige sleutelvinders (MAC-adres), iBeacon en Eddystone.
- **Nog niet:** Google Find Hub-tags (zoals Fresh 'n Rebel in Find Hub) wisselen steeds van ID. Die
  herkent QuitFind pas met de sleutel van de tag uit je Google-account (geplande, optionele Google-brug).

## Gebruiken
**Server** (Docker):
```
cd server && docker build -t quitfind-server:dev .
```
Een voorbeeld staat in [docs/docker-compose.example.yml](docs/docker-compose.example.yml); de testopzet in `NOTES.md`. De database is dezelfde als die van FMD 0.17.1 (alleen een datatype erbij):
een bestaande FMD-server kan overstappen, maar **maak eerst een back-up** van de database.

**Webpagina:** open de server in je browser → "Nieuw eigenaar-account" (met de registratiecode van de
server) → apparaten koppelen (naam + wachtwoord van hun FMD-account) en tags toevoegen.

**Android:**
```
cd android && ./gradlew assembleDevDebug     # Java 21 + Android-SDK; APK in app/build/outputs/apk/dev/debug/
```
Tab **Kaart** → serveradres, naam en wachtwoord van het eigenaar-account → koppelen. Met de schakelaar
"Mijn tags zoeken met deze telefoon" zoekt de telefoon voortaan zelf.

**Desktop:**
```
cd desktop && cargo build --release
```
Tab **Connect** → "QuitFind server" → koppelen.

## Tests
- `node tests/fmd_v2_vectors.mjs` – versleuteling (zelfde vectoren als Android, web en Rust)
- `node tests/e2e_register.mjs` – register, apparaten en tagwaarnemingen tegen de testserver
- `tests/web/run_dashboard_browser.sh` – webpagina in headless Firefox
- Android: `./gradlew testDevDebugUnitTest --tests 'de.nulide.findmydevice.quitfind.*'`
- Desktop: `cargo test fmd::` en `node tests/desktop_sync.mjs`

Alle tests draaien alleen tegen een testserver, nooit tegen een echte.

## Licentie
GPL-3.0, net als FMD.

## English summary
QuitFind is a GPL-3.0 fork of FMD (Find My Device). It adds an end-to-end encrypted device register to the
server, a web dashboard with all your devices on one map, an Android map tab plus scanning for your own
Bluetooth tags (MAC, iBeacon, Eddystone), and a Linux desktop app that shows all your devices. Tags are
located only by your own devices (no crowd network). Google Find Hub tags are not supported yet.
