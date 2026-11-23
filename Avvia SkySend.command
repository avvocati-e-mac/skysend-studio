#!/bin/bash
set -eu
umask 077
cd -- "$(dirname -- "$0")"

fail() {
  printf '\n%s\n' "$*" >&2
  if [[ -t 0 ]]; then read -r -p "Premi Invio per chiudere. " _ || true; fi
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail "Su Windows o Linux, segui il README."
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v docker >/dev/null || fail "Installa e apri OrbStack da https://orbstack.dev, poi lancia di nuovo questo file."
docker context inspect orbstack >/dev/null 2>&1 || fail "Apri OrbStack almeno una volta, poi lancia di nuovo questo file."
docker_cmd=(docker --context orbstack)
state_dir="$HOME/Library/Application Support/SkySend Studio"
token_dir="$HOME/Library/Application Support/SkySend Studio Tunnel"
token_path="$token_dir/tunnel-token"
if ! "${docker_cmd[@]}" info >/dev/null 2>&1; then
  open -a OrbStack || fail "Apri OrbStack e riprova."
  printf 'Attendo che OrbStack si avvii…\n'
  for (( attempt=0; attempt<20; attempt++ )); do
    "${docker_cmd[@]}" info >/dev/null 2>&1 && break
    sleep 1
  done
fi
"${docker_cmd[@]}" info >/dev/null 2>&1 || fail "OrbStack non è ancora pronto. Aprilo e riprova."

if [[ "${1:-}" == "--configura" || "${1:-}" == "--configura-token" ]]; then
  configure=yes
elif [[ ! -f .env ]] || ! grep -q '^SKYSEND_WORK_DIR=' .env; then
  configure=yes
else
  configure=no
fi

mkdir -p "$state_dir" "$token_dir"
chmod 700 "$state_dir" "$token_dir"
if [[ ! -s "$token_path" || "${1:-}" == "--configura-token" ]]; then
  if [[ -s secrets/tunnel-token && "${1:-}" != "--configura-token" ]]; then
    printf '\nIl token precedente è nella cartella del progetto. Ruotalo in Cloudflare e incolla il nuovo token qui sotto.\n'
  else
    printf '\nIn Cloudflare, apri Servizi rete → Tunnels, crea un tunnel e seleziona Docker.\n'
    printf 'Copia il solo token. Questo script avvierà il connettore richiesto dal pulsante Continua.\n'
  fi
  token=''
  while [[ ! "$token" =~ ^eyJ[A-Za-z0-9_+/=-]+$ ]]; do
    read -r -s -p "Incolla il token dopo --token e premi Invio: " token || fail "Configurazione interrotta."
    printf '\n'
    [[ "$token" =~ ^eyJ[A-Za-z0-9_+/=-]+$ ]] || printf 'Serve il solo token che inizia per eyJ.\n'
  done
  token_file="$(mktemp "$token_dir/tunnel-token.XXXXXXXX")"
  printf '%s\n' "$token" > "$token_file"
  chmod 644 "$token_file"
  mv -f "$token_file" "$token_path"
  unset token
  recreate_connector=yes
else
  recreate_connector=no
fi
export SKYSEND_TUNNEL_TOKEN_FILE="$token_path"

if [[ "$configure" == yes ]]; then
  printf '\nScegli il sottodominio da pubblicare in Cloudflare dopo la connessione del tunnel.\n'
  printf 'Guida: https://developers.cloudflare.com/tunnel/get-started/\n\n'
  while true; do
    read -r -p "Sottodominio pubblico, es. invii.studio.it: " hostname || fail "Configurazione interrotta."
    hostname="${hostname#https://}"
    hostname="${hostname%/}"
    if [[ "$hostname" =~ ^([[:alnum:]]([[:alnum:]-]*[[:alnum:]])?\.)+[[:alpha:]][[:alnum:]-]*$ && "$hostname" != *.example.com && "$hostname" != *.local ]]; then
      break
    fi
    printf 'Inserisci il solo sottodominio pubblico.\n'
  done
  default_work="$HOME/Documents/SkySend"
  printf 'Se Documenti è sincronizzata con iCloud, puoi indicare una cartella fuori da Documenti.\n'
  read -r -p "Cartella di lavoro [${default_work}]: " work_dir || fail "Configurazione interrotta."
  work_dir="${work_dir:-$default_work}"
  work_dir="${work_dir/#\~/$HOME}"
  [[ "$work_dir" == /* && "$work_dir" != *\'* && "$work_dir" != *\\* ]] || fail "Inserisci un percorso assoluto senza apostrofi o barre inverse."
  mkdir -p "$work_dir/Download per i clienti" "$work_dir/Upload dai clienti" "$state_dir"
  if [[ -L "$work_dir/Download per i clienti" || -L "$work_dir/Upload dai clienti" ]]; then
    fail "Scegli una cartella di lavoro con due sottocartelle reali, senza collegamenti simbolici."
  fi
  chmod 700 "$state_dir"
  tmp_env="$(mktemp .env.XXXXXXXX)"
  printf "SKYSEND_HOSTNAME=%s\nSKYSEND_WORK_DIR='%s'\nSKYSEND_STATE_DIR='%s'\nSKYSEND_UID=%s\nSKYSEND_GID=%s\n" \
    "$hostname" "$work_dir" "$state_dir" "$(id -u)" "$(id -g)" > "$tmp_env"
  if [[ -f .env ]]; then
    sed -n '/^SKYSEND_FILE_MAX_SIZE=/p; /^SKYSEND_UPLOAD_QUOTA=/p' .env >> "$tmp_env"
  fi
  mv -f "$tmp_env" .env
fi
if ! grep -Fxq "SKYSEND_TUNNEL_TOKEN_FILE='$token_path'" .env; then
  tmp_env="$(mktemp .env.XXXXXXXX)"
  sed '/^SKYSEND_TUNNEL_TOKEN_FILE=/d' .env > "$tmp_env"
  printf "\nSKYSEND_TUNNEL_TOKEN_FILE='%s'\n" "$token_path" >> "$tmp_env"
  mv -f "$tmp_env" .env
fi

printf '\nAvvio SkySend. Al primo avvio Docker scarica le immagini.\n'
if ! "${docker_cmd[@]}" compose up -d --remove-orphans --wait --wait-timeout 120; then
  "${docker_cmd[@]}" compose ps || true
  fail "SkySend non si è avviato. Leggi il messaggio qui sopra o controlla i log con docker compose logs."
fi
if [[ "$recreate_connector" == yes ]]; then
  "${docker_cmd[@]}" compose up -d --force-recreate cloudflared
fi
printf 'Pannello: http://127.0.0.1:8787\n'
open 'http://127.0.0.1:8787'
public_host="$(sed -n 's/^SKYSEND_HOSTNAME=//p' .env | head -n 1)"
if curl -fsS --max-time 8 "https://$public_host/api/config" 2>/dev/null | grep -q '"fileRequestsEnabled":true'; then
  public_root_status="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "https://$public_host/" 2>/dev/null || true)"
  if [[ "$public_root_status" == 404 ]]; then
    printf 'L’ingresso per i clienti risponde. Prima di usare documenti reali, prova i due link in una finestra privata.\n'
  else
    printf 'Attenzione: l’indirizzo pubblico non restituisce il risultato atteso. Controlla la route prima di condividere documenti.\n'
  fi
else
  printf 'Il pannello locale è pronto. Il sottodominio non risponde ancora come SkySend.\n'
  printf 'Torna a Cloudflare. Quando il connettore risulta collegato, premi Continua e aggiungi la Published application con destinazione http://skysend:3000.\n'
  printf 'Se avevi già aggiunto la route, verifica lo stato del tunnel e la sua destinazione.\n'
fi
