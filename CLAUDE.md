# QuitFind – eigen "Find Hub" op basis van FMD

Antwoord Abel in het **Nederlands**. Lees eerst `NOTES.md` (logboek: stand, besluiten,
open punten) en werk dat logboek bij na elke stap, zodat werk na een crash of tokenpauze
precies hervat kan worden.

## Wat het is
Een fork van FMD (Find My Device, GPL-3.0) die meer kan dan telefoons volgen:
Bluetooth-tags, laptops en pc's, met een echte kaart in de Android-app en een
Linux-desktopapp. Onderdeel van de latere **QuitSuite** (QuitChat, QuitFind, QuitCloud).

## Vaste gegevens
- Huidige FMD-server: `~/fmd-server` (docker, image fmd-server 0.17.1, 127.0.0.1:8090)
  → `https://debian.tail7c7f5b.ts.net:8443`. Daar draaien echte gegevens: niet breken.
  Nieuwe versies eerst naast de bestaande testen (andere poort), pas dan overzetten.
- ntfy: 127.0.0.1:8091 → `:10000`. Bezette Tailscale-poorten: 443, 8443, 10000.
- Desktopbasis: `~/Documents/Craft Anything/google-s-find-hub-3-1-805-02/app`
  (Rust + egui, clean room gebouwd; de Google-app is nooit geopend — zo houden).
- Repo's openbaar op GitHub en Codeberg als AbelDrift/QuitFind; commits met
  het Codeberg-noreply-adres. Licentie GPL-3.0 (verplicht door de FMD-fork).

## Regels
- Geen code of bestanden van Google (Find Hub) of Apple (Find My) openen of nabouwen:
  alleen eigen ontwerp en open bronnen.
- Zwaar werk (Gradle, cargo build) één tegelijk met geheugenlimiet:
  `systemd-run --user --scope -p MemoryMax=… -p MemorySwapMax=0 nice -n 10 …`.
