#!/usr/bin/env bash
# Zet de echte FMD-server over op het QuitFind-image, met back-up en een weg terug.
#   tools/server-overzetten.sh           overzetten (vraagt eerst bevestiging)
#   tools/server-overzetten.sh --terug   terug naar de laatste back-up (oude image en database)
# Getest op een kopie van de echte database: "nothing to migrate", zelfde accounts (zie NOTES.md).
# FMD_DIR / FMD_PORT / JA=1 bestaan alleen om dit script op een proefserver te testen.
set -euo pipefail
DIR="${FMD_DIR:-$HOME/fmd-server}"
PORT="${FMD_PORT:-8090}"
NEW="quitfind-server:dev"
COMPOSE="$DIR/docker-compose.yml"
dc() { (cd "$DIR" && docker compose "$@"); }
users() { docker exec "$(dc ps -q fmd)" /opt/fmd-server-ctl listusers -r -l 100000 2>/dev/null | tail -1; }
healthy() { # zelfde aantal accounts, versie en webpagina
  for _ in $(seq 1 20); do
    [[ "$(curl -s "http://127.0.0.1:$PORT/version" || true)" == 0.17.* ]] && break
    sleep 1
  done
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")" == 200 && "$(users)" == "$1" ]]
}

terug() {
  local b; b="$(ls -d "$DIR"/backup-* 2>/dev/null | tail -1)"
  [[ -n "$b" ]] || { echo "Geen back-up gevonden in $DIR."; exit 1; }
  echo "Terug naar $b …"
  dc stop fmd
  rm -rf "$DIR/fmddata/db" && cp -a "$b/db" "$DIR/fmddata/db"
  cp "$b/docker-compose.yml" "$COMPOSE"
  dc up -d fmd
  echo "Teruggezet: $(grep -m1 'image:' "$COMPOSE" | xargs)"
}

if [[ "${1:-}" == "--terug" ]]; then terug; exit 0; fi

docker image inspect "$NEW" >/dev/null 2>&1 || { echo "Bouw eerst het image: cd server && docker build -t $NEW ."; exit 1; }
grep -q "image: $NEW" "$COMPOSE" && { echo "Draait al op $NEW."; exit 0; }
before="$(users)"
echo "Nu: $(grep -m1 'image:' "$COMPOSE" | xargs) — $before"
if [[ "${JA:-}" != 1 ]]; then
  read -r -p "De server gaat ±10 s uit en start daarna als QuitFind. Eerst komt er een back-up. Doorgaan? [j/N] " a
  [[ "$a" == j ]] || { echo "Niets gedaan."; exit 0; }
fi
b="$DIR/backup-$(date +%Y%m%d-%H%M%S)"
dc stop fmd # stilgezet, zodat de database (met WAL) consistent gekopieerd wordt
mkdir -p "$b" && cp -a "$DIR/fmddata/db" "$b/db" && cp "$COMPOSE" "$b/docker-compose.yml"
sed -i "s|^\(\s*image:\s*\).*fmd-server.*$|\1$NEW|" "$COMPOSE"
dc up -d fmd
if healthy "$before"; then
  echo "Klaar: de server draait nu als QuitFind ($before). Back-up: $b"
  echo "Terug kan altijd met: tools/server-overzetten.sh --terug"
else
  echo "Controle mislukt (versie, webpagina of aantal accounts): automatisch terug."
  terug
  exit 1
fi
