#!/bin/sh
set -eu

# Riusa il template della versione SkySend in esecuzione e carica il filtro
# prima del codice dell'app. Le richieste HTTP restano filtrate dal Caddyfile.
pages=/tmp/skysend-pages
mkdir -p "$pages"
wget -q -O "$pages/upstream.html" http://server:3000/
anchor='<script src="/theme-init.js"></script>'
if ! grep -Fq "$anchor" "$pages/upstream.html"; then
  printf '%s\n' 'Template SkySend inatteso: verifica la pagina cliente dopo l’aggiornamento.' >&2
  exit 1
fi
sed 's%<script src="/theme-init.js"></script>%&<script src="/studio-client.js"></script>%' \
  "$pages/upstream.html" > "$pages/index.html"
rm "$pages/upstream.html"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
