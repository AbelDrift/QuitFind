# Google-brug A (optioneel, standaard uit)

Hiermee komen de locaties van je **Google Find Hub-tags** (zoals Fresh 'n Rebel) in QuitFind, ook als
geen van je eigen apparaten in de buurt was: Google's netwerk van telefoons vindt ze, de brug haalt het
resultaat op. QuitFind zelf bevat **geen Google-code**; dat doet een apart open-sourceproject.

> Status: de **adapter** (`ingest.mjs`) is gebouwd en getest (`node tests/bridge_ingest.mjs`).
> De Google-brug zelf en `docker-compose.yml` zijn een **sjabloon**: nog niet gedraaid met een echt
> Google-account.

## Hoe het werkt
```
Google Find Hub ──► Google-brug (container, jouw reserve-account) ──OsmAnd──► adapter ──► QuitFind-server
                                                                     (sleutel)    (versleuteld in het tag-account)
```
- De Google-brug is [GoogleFindMyToolsWebUi](https://github.com/P6g9YHK6/GoogleFindMyToolsWebUi)
  (GPL-3.0), een afgeleide van GoogleFindMyTools. Het doet zich bij Google voor als de Find Hub-app.
- De adapter accepteert alleen meldingen met de juiste sleutel, voor tags die in je register staan, en
  alleen als in de instellingen van de webpagina **"Google-brug: A, via de server"** gekozen is.

## Risico's (lees dit eerst)
- **Account:** dit is geen officiële toegang. Google kan tokens intrekken of het account blokkeren.
  Gebruik daarom een **reserve-Google-account** en laat de tags eigendom van je hoofdaccount: deel ze
  in Find Hub met het reserve-account.
- **Piepen:** gebruikers melden dat tags (ook Fresh 'n Rebel) soms willekeurig piepen bij opvragen.
  Houd het aantal opvragingen laag.
- **Onderhoud:** als Google iets verandert, werkt de brug tijdelijk niet tot het project is bijgewerkt.
  QuitFind blijft gewoon werken.

## Stappen
1. **Reserve-account:** deel elke tag in Find Hub vanuit je hoofdaccount met je reserve-Google-account en
   accepteer de uitnodiging (op een telefoon met dat account).
2. **Tags in QuitFind:** voeg elke tag op de webpagina toe als tag van soort *FMDN* (de ID mag de naam uit
   Find Hub zijn). Noteer de accountnaam van de tag (`t-…`, zichtbaar in het register).
3. **Geheimen** (buiten git, alleen leesbaar voor jou):
   - `adapter-sleutel`: een lange willekeurige tekst (`openssl rand -base64 32`);
   - `eigenaar-pwk64`: de opgeslagen sleutel van je eigenaar-account (te halen met
     `node -e` en `lib/quitfind_v2.mjs`, of uit de Android-app na koppelen);
   - `gfmt.env`: de instellingen van de Google-brug (gebruikersnaam/wachtwoord van zijn web-UI, een
     versleutelingssleutel, `EID_UPLOAD=off`, een lage `QUERY_THROTTLE_MAX`). Controleer de namen in de
     README van het project.
4. **Vastpinnen:** lees de code van de Google-brug na en zet in `docker-compose.yml` de image vast op
   die versie (`@sha256:…`).
5. **Starten:** `docker compose up -d` en open `http://127.0.0.1:4321` op deze pc. Log daar **eenmalig**
   in met Chrome en de pincode van de schermvergrendeling (vraagt de brug zelf). Doe dit als er niets
   zwaars draait: Chrome gebruikt tijdelijk veel geheugen.
6. **Doorsturen:** stel in de Google-brug per tag een doorstuuradres in:
   `http://qf-ingest:5055/?id=<t-account>&key=<adapter-sleutel>&lat={{latitude}}&lon={{longitude}}&timestamp={{google_timestamp}}&accuracy={{accuracy_m}}&status={{status}}`
7. **Aanzetten:** kies op de webpagina bij Instellingen → Google-brug: **A: via de server**.

## Optie B (reservetelefoon)
Voorbereid in de instellingen, maar nog niet gebouwd: de onderzochte manieren (meldingen of het scherm
van de Find Hub-app uitlezen) zijn breekbaar. Optie A is aanbevolen.
