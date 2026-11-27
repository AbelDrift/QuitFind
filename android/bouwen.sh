#!/usr/bin/env bash
# QuitFind bouwen voor Android (zoals bouwen.sh van QuitChat).
#   ./bouwen.sh              testversie (dev, debug)        → app/build/outputs/apk/dev/debug/
#   ./bouwen.sh release      ondertekende versie (prod)    → app/build/outputs/apk/prod/release/
#   … --installeren          daarna installeren op de aangesloten telefoon (adb)
# Het standaard serveradres staat niet in de broncode: zet het in ~/.config/quitfind/adres (één regel).
# Zwaar werk: met geheugenlimiet, zodat de pc niet vastloopt.
set -euo pipefail
cd "$(dirname "$0")"
soort=debug; installeren=
for a in "$@"; do case "$a" in release) soort=release ;; --installeren) installeren=1 ;; *) echo "onbekend: $a"; exit 1 ;; esac; done
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.13+9}" ANDROID_HOME="${ANDROID_HOME:-$HOME/ontwikkeling/android-sdk}"
adres="$(cat "$HOME/.config/quitfind/adres" 2>/dev/null || true)"
if [[ "$soort" == release ]]; then
  [[ -f key.properties ]] || { echo "Geen key.properties: maak eerst een sleutel met ./sleutel-maken.sh"; exit 1; }
  taak=assembleProdRelease; uit=app/build/outputs/apk/prod/release
else
  taak=assembleDevDebug; uit=app/build/outputs/apk/dev/debug
fi
systemd-run --user --scope -q -p MemoryMax=3500M -p MemorySwapMax=0 nice -n 10 ./gradlew --no-daemon --console=plain \
  -Dorg.gradle.jvmargs=-Xmx1536m -Pkotlin.compiler.execution.strategy=in-process ${adres:+-PquitfindServer="$adres"} "$taak"
apk="$(ls "$uit"/*.apk | head -1)"; echo "Klaar: $apk"
if [[ -n "$installeren" ]]; then "$ANDROID_HOME/platform-tools/adb" install -r "$apk"; fi
