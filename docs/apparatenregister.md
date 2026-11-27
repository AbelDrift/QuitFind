# QuitFind-apparatenregister (formaat v1)

Eén keer inloggen en al je apparaten zien: dat regelt het **apparatenregister**. Het staat
versleuteld op de server, in een apart **eigenaar-account**. Dat is een gewoon FMD-account
(protocol v2) dat zelf geen apparaat is.

## Model
- **Elk apparaat is een eigen FMD-account**: telefoon, tablet, laptop, pc en ook elke tag.
  Zo blijven gewone FMD-apps werken (één account = één apparaat, zoals upstream).
- Het eigenaar-account bewaart per apparaat één item van het datatype **`device`**
  (QuitFind-uitbreiding van de server; wordt nooit opgeschoond).
- Tags hebben geen eigen processor. Telefoons, laptops en de Google-brug loggen in op het
  account van de tag en sturen daar een gewone versleutelde locatie heen
  (`provider: "ble"` of `"google"`).

## Versleuteling
Zoals de andere FMD-v2-datatypen, met een eigen sleutel voor het register:

```
K_kek_device = HKDF-SHA256(K_master_eigenaar, info = "quitfind_v1_kek_device" || SHA256(gebruikersnaam_eigenaar))
```

Elk item is een FMD-v2-datablob (`IV_dek || GCM_KEK(DEK) || tag || IV_data || GCM_DEK(json) || tag`)
met type `"device"` in de associated data, net als `location`. Een eigen HKDF-context zorgt dat
de sleutel nooit samenvalt met die van upstream-typen.

## Inhoud van een item (JSON)
```json
{
  "v": 1,
  "kind": "device",
  "username": "fmd-accountnaam van het apparaat",
  "server": "",
  "pwk64": "base64 van K_pwk van dat account",
  "name": "Fairphone van Abel",
  "type": "phone | tablet | laptop | pc | tag",
  "tag": { "kind": "ibeacon | eddystone | mac | fmdn", "id": "…", "eik64": "…" },
  "addedAt": 1764200000000
}
```
- `server` leeg = dezelfde server als het eigenaar-account.
- `pwk64` (de uitkomst van Argon2) laat een app inloggen zonder voor elk apparaat
  128 MiB Argon2 te draaien: `K_auth = HKDF(K_pwk, "fmd_v2_auth" || SHA256(naam))`,
  `K_pmk = HKDF(K_pwk, "fmd_v2_premaster" || SHA256(naam))`.
- `tag` alleen bij tags: hoe de tag via Bluetooth te herkennen is.

Daarnaast hoogstens één item met `"kind": "settings"`, bijvoorbeeld met de
`registrationToken` van de server (nodig om tag-accounts aan te maken).

Een apparaat wijzigen = nieuw item plaatsen en het oude verwijderen
(`DELETE /api/v2/data/device/{clientItemIdHex}`).

## Veiligheid
Het register bevat de sleutels van al je apparaten, versleuteld met het wachtwoord van het
eigenaar-account. Kies daarvoor dus een sterk, apart wachtwoord. De server ziet alleen
versleutelde blobs.
