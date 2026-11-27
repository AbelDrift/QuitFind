#!/usr/bin/env bash
# Maakt eenmalig de sleutel waarmee QuitFind-releases ondertekend worden (zoals bij QuitChat).
# De sleutel en het wachtwoord staan buiten de broncode (~/ontwikkeling/quitfind-sleutel);
# android/key.properties wijst ernaar en staat in .gitignore.
# Maak een reservekopie van die map: zonder sleutel kan een geïnstalleerde QuitFind niet meer worden bijgewerkt.
set -euo pipefail
cd "$(dirname "$0")"
MAP="$HOME/ontwikkeling/quitfind-sleutel"
JKS="$MAP/quitfind-release.jks"
[[ -f "$JKS" ]] && { echo "Er is al een sleutel: $JKS (niets gedaan)."; exit 0; }
KEYTOOL="${JAVA_HOME:-$HOME/.local/opt/jdk-21.0.13+9}/bin/keytool"
mkdir -p "$MAP"; chmod 700 "$MAP"
ww="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
"$KEYTOOL" -genkeypair -v -keystore "$JKS" -storetype PKCS12 \
  -alias quitfind -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$ww" -keypass "$ww" -dname "CN=QuitFind" >/dev/null
chmod 600 "$JKS"
umask 077
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=quitfind\nkeyPassword=%s\n' "$JKS" "$ww" "$ww" > key.properties
cp key.properties "$MAP/key.properties"
echo "Sleutel gemaakt: $JKS — maak een reservekopie van $MAP."
