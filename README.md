# QuitFind

Vind je telefoons, tablets, laptops en Bluetooth-tags terug via je eigen server – zonder Google.
QuitFind is een uitbreiding (fork) van [FMD – Find My Device](https://gitlab.com/fmd-foss) en
hoort bij **QuitSuite** (QuitChat, QuitFind en later QuitCloud).

> Stand: plan en opzet. Nog niets bruikbaars.

## Onderdelen
| onderdeel | basis | wat er bij komt |
|---|---|---|
| **server** | fork van FMD-server | meer soorten apparaten (tags, laptops, pc's), één kaart met alles, locatiegeschiedenis |
| **Android-app** | fork van FMD-android | kaart (OpenStreetMap) met alle apparaten en bediening in de app zelf; Bluetooth-tags in de buurt opmerken en doorgeven |
| **Linux-desktopapp** | eigen Rust/egui-app | laptop/pc als apparaat, kaart, tags scannen |

## Eerlijk over tags
Een goedkope Bluetooth-tag weet zelf niet waar hij is: hij roept alleen "ik ben tag X".
De locatie komt van het apparaat dat hem hoort. Google Find Hub laat daarvoor alle
Android-telefoons ter wereld meeluisteren; QuitFind gebruikt alleen **jouw eigen apparaten**.
Een tag wordt dus gevonden als een van je eigen apparaten in de buurt komt (thuis, auto,
onderweg met je telefoon), niet als hij ergens in de stad ligt waar jij niet komt.

## Licentie
GPL-3.0, net als FMD.

## English summary
QuitFind is a GPL-3.0 fork of FMD (Find My Device) that also tracks Bluetooth tags, laptops and
desktops, adds a map-based Android app and a Linux desktop app, all through your own server.
Tags are located only by your own devices (no crowd network).
