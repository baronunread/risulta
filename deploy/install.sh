#!/bin/sh
set -eu

REPOSITORY="${RISULTA_REPOSITORY:-baronunread/risulta}"
INSTALL_PATH="/usr/local/bin/risulta"
ENV_DIR="/etc/risulta"
ENV_FILE="$ENV_DIR/risulta.env"
DATA_DIR="/var/lib/risulta"
SERVICE_FILE="/etc/systemd/system/risulta.service"
PORT="${RISULTA_PORT:-}"

say() { printf '%s\n' "$*"; }
fail() { say "Error: $*" >&2; exit 1; }
step() {
  label="$1"; shift
  log="$tmp_dir/step.log"
  if [ -t 1 ]; then
    "$@" >"$log" 2>&1 & pid=$!
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
      *.[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' ;;
      *) frames='-|/\\' ;;
    esac
    frame_count=$(printf '%s' "$frames" | wc -m | tr -d ' ')
    index=1
    while kill -0 "$pid" 2>/dev/null; do
      frame=$(printf '%s' "$frames" | cut -c "$index")
      printf '\r%s %s' "$frame" "$label" > /dev/tty
      frame_count=${frame_count:-4}
      index=$((index % frame_count + 1)); sleep 0.08
    done
    wait "$pid" || { printf '\r' > /dev/tty; cat "$log" >&2; fail "$label failed."; }
    printf '\r✓ %s\n' "$label" > /dev/tty
  else
    say "$label"
    "$@" || fail "$label failed."
  fi
}
prompt() {
  label="$1"; default="${2:-}"
  if [ -n "$default" ]; then printf '%s [%s]: ' "$label" "$default" > /dev/tty; else printf '%s: ' "$label" > /dev/tty; fi
  IFS= read -r answer < /dev/tty || fail "Unable to read from the terminal."
  if [ -z "$answer" ]; then answer="$default"; fi
  printf '%s' "$answer"
}
confirm() {
  label="$1"; default="${2:-y}"
  if [ "$default" = "y" ]; then suffix="Y/n"; else suffix="y/N"; fi
  printf '%s [%s]: ' "$label" "$suffix" > /dev/tty
  IFS= read -r answer < /dev/tty || fail "Unable to read from the terminal."
  answer="${answer:-$default}"
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}
secret() {
  label="$1"
  printf '%s: ' "$label" > /dev/tty
  stty -echo < /dev/tty
  IFS= read -r answer < /dev/tty || { stty echo < /dev/tty; fail "Unable to read from the terminal."; }
  stty echo < /dev/tty
  printf '\n' > /dev/tty
  printf '%s' "$answer"
}
env_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
saved_setting() {
  key="$1"
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^${key}=\"\(.*\)\"$/\1/p" "$ENV_FILE" | tail -n 1
}
detected_host_proxies() {
  found=""
  for proxy in caddy nginx apache2 httpd traefik haproxy; do
    if command -v "$proxy" >/dev/null 2>&1; then found="$found $proxy"; fi
  done
  printf '%s' "${found# }"
}
choose_proxy_mode() {
  default_choice="$1"
  {
    say ""
    say "How should HTTPS be handled?"
    say "  1) Install or configure Caddy automatically (recommended on a new server)"
    say "  2) Use an existing host reverse proxy (nginx, Apache, Traefik, or Caddy)"
    say "  3) Direct HTTP only (development or a private network)"
    say ""
    say "Docker deployment is kept separate so Risulta and its proxy can share one Compose network."
  } > /dev/tty
  while :; do
    choice="$(prompt "Choose 1, 2, or 3" "$default_choice")"
    case "$choice" in
      1) printf '%s' caddy; return ;;
      2) printf '%s' existing; return ;;
      3) printf '%s' direct; return ;;
      *) say "Enter 1, 2, or 3." > /dev/tty ;;
    esac
  done
}
caddy_failure() {
  say ""
  say "Caddy could not start. Risulta and its administrator account are still installed."
  say "Caddy status:"
  systemctl status caddy --no-pager -l >&2 || true
  say "Recent Caddy logs:"
  journalctl -u caddy -n 50 --no-pager >&2 || true
  if command -v ss >/dev/null 2>&1; then
    say "Processes listening on web ports:"
    ss -ltnp '( sport = :80 or sport = :443 )' >&2 || true
  fi
  fail "Fix the Caddy error above, then rerun this installer; saved settings will be offered."
}

[ "$(id -u)" -eq 0 ] || fail "Run this installer as root: curl -fsSL <installer-url> | sudo sh"
[ -r /dev/tty ] || fail "An interactive terminal is required. Download the script first if needed."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v systemctl >/dev/null 2>&1 || fail "Risulta currently requires a systemd-based Linux server."

case "$(uname -s)" in Linux) ;; *) fail "Only Linux servers are supported by this installer." ;; esac
case "$(uname -m)" in
  x86_64|amd64) artifact="risulta-linux-x64" ;;
  aarch64|arm64) artifact="risulta-linux-arm64" ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

say ""
say "Risulta installer"
say "Private web analytics in one binary."
say ""

download_base="https://github.com/$REPOSITORY/releases/latest/download"
manifest="$(curl --proto '=https' --tlsv1.2 -fsSL "$download_base/risulta-release.json" 2>/dev/null || true)"
latest_version="$(printf '%s\n' "$manifest" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
[ -n "$latest_version" ] || fail "Unable to read release metadata. Try again later."
installed_version=""
if [ -x "$INSTALL_PATH" ]; then installed_version="$($INSTALL_PATH --version 2>/dev/null || true)"; fi
say "Installed: ${installed_version:-not installed}"
say "Available: $latest_version"
if [ -n "$installed_version" ] && [ "$installed_version" = "$latest_version" ]; then
  say "Risulta is up to date."
  exit 0
fi

fresh_install=1
if [ -f "$DATA_DIR/control.db" ]; then
  fresh_install=0
  say "Existing Risulta data and administrator found. They will not be replaced."
fi

release_breaking="$(printf '%s\n' "$manifest" | sed -n 's/.*"breaking"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' | head -n 1)"
breaking_update=0
if [ "$fresh_install" -eq 0 ] && [ -n "$installed_version" ]; then
  installed_major="$(printf '%s' "$installed_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')"
  latest_major="$(printf '%s' "$latest_version" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1/p')"
  if [ "$release_breaking" = true ] || { [ -n "$installed_major" ] && [ -n "$latest_major" ] && [ "$latest_major" -gt "$installed_major" ]; }; then
    breaking_update=1
    say ""
    say "Breaking update: $installed_version to $latest_version"
    say "A safety backup will be created before the service is replaced."
    confirm "Continue with this breaking update?" n || exit 0
  fi
fi

saved_base_url="$(saved_setting RISULTA_BASE_URL)"
saved_proxy="$(saved_setting RISULTA_TRUST_PROXY)"
saved_proxy_mode="$(saved_setting RISULTA_PROXY_MODE)"
saved_port="$(saved_setting PORT)"
[ -n "$PORT" ] || PORT="${saved_port:-3000}"
case "$saved_proxy" in 1) ;; *) saved_proxy=0 ;; esac
case "$saved_proxy_mode" in
  caddy|existing|direct) ;;
  *) if [ "$saved_proxy" = "1" ]; then saved_proxy_mode=caddy; else saved_proxy_mode=direct; fi ;;
esac

saved_domain=""
case "$saved_base_url" in
  https://*) saved_domain="${saved_base_url#https://}" ;;
  http://*) saved_domain="${saved_base_url#http://}"; saved_domain="${saved_domain%:$PORT}" ;;
esac

reuse_settings=0
if [ -n "$saved_domain" ]; then
  case "$saved_proxy_mode" in
    caddy) saved_mode_label="automatic Caddy" ;;
    existing) saved_mode_label="existing reverse proxy" ;;
    direct) saved_mode_label="direct HTTP" ;;
  esac
  say "Saved configuration: domain $saved_domain, port $PORT, $saved_mode_label."
  if confirm "Keep these settings?" y; then reuse_settings=1; fi
fi

if [ "$reuse_settings" -eq 1 ]; then
  domain="$saved_domain"
  proxy_mode="$saved_proxy_mode"
else
  domain="$(prompt "Analytics domain (for example, stats.example.com)" "$saved_domain")"
  case "$domain" in
    ""|*://*|*/*|*:*|*' '*|*'{'*|*'}'*) fail "Enter a hostname only, without a scheme, port, path, or spaces." ;;
  esac

  detected_proxies="$(detected_host_proxies)"
  default_proxy_choice=1
  if [ -n "$detected_proxies" ]; then
    say "Detected host proxy software: $detected_proxies"
    [ "$detected_proxies" = "caddy" ] || default_proxy_choice=2
  fi
  if command -v ss >/dev/null 2>&1; then
    web_listeners="$(ss -H -ltnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
    if [ -n "$web_listeners" ]; then
      say "Detected listeners on ports 80 or 443:"
      say "$web_listeners"
      [ -z "$detected_proxies" ] && default_proxy_choice=2
    fi
  fi
  proxy_mode="$(choose_proxy_mode "$default_proxy_choice")"
fi

if [ "$fresh_install" -eq 1 ]; then
  admin_email="$(prompt "Administrator email")"
  case "$admin_email" in *@*.*) ;; *) fail "Enter a valid administrator email." ;; esac
  admin_password="$(secret "Administrator password (12 characters or more)")"
  [ "${#admin_password}" -ge 12 ] || fail "The administrator password must contain at least 12 characters."
  admin_password_again="$(secret "Confirm administrator password")"
  [ "$admin_password" = "$admin_password_again" ] || fail "The passwords do not match."
fi

case "$proxy_mode" in
  caddy) base_url="https://$domain"; listen_host="127.0.0.1"; trust_proxy=1; use_caddy=1 ;;
  existing) base_url="https://$domain"; listen_host="127.0.0.1"; trust_proxy=1; use_caddy=0 ;;
  direct) base_url="http://$domain:$PORT"; listen_host="0.0.0.0"; trust_proxy=0; use_caddy=0 ;;
  *) fail "Unknown proxy mode: $proxy_mode" ;;
esac

tmp_dir="$(mktemp -d /tmp/risulta-install.XXXXXX)"
policy_created=0
cleanup() {
  if [ "$policy_created" -eq 1 ]; then rm -f /usr/sbin/policy-rc.d; fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

if [ "$breaking_update" -eq 1 ]; then
  command -v "$INSTALL_PATH" >/dev/null 2>&1 || fail "The installed binary cannot create the required safety backup."
  install -d -m 0750 /var/backups/risulta
  step "Creating safety backup" "$INSTALL_PATH" backup /var/backups/risulta
fi
say ""
step "Downloading $artifact" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$artifact" -o "$tmp_dir/$artifact"
step "Downloading checksum" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$artifact.sha256" -o "$tmp_dir/$artifact.sha256"
(
  cd "$tmp_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$artifact.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "$artifact.sha256")"
    actual="$(shasum -a 256 "$artifact" | awk '{print $1}')"
    [ "$expected" = "$actual" ] || fail "The downloaded binary failed checksum verification."
  else
    fail "sha256sum or shasum is required to verify the download."
  fi
)
say "✓ Checksum verified"

if ! id risulta >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin risulta
fi
install -d -m 0750 -o risulta -g risulta "$DATA_DIR" "$ENV_DIR"
install -m 0755 "$tmp_dir/$artifact" "$tmp_dir/risulta.new"
mv -f "$tmp_dir/risulta.new" "$INSTALL_PATH"

previous_umask="$(umask)"
umask 077
env_tmp="$tmp_dir/risulta.env"
{
  printf 'HOST="%s"\n' "$(env_quote "$listen_host")"
  printf 'PORT="%s"\n' "$(env_quote "$PORT")"
  printf 'DATA_DIR="%s"\n' "$(env_quote "$DATA_DIR")"
  printf 'RISULTA_BASE_URL="%s"\n' "$(env_quote "$base_url")"
  printf 'RISULTA_TRUST_PROXY="%s"\n' "$trust_proxy"
  printf 'RISULTA_PROXY_MODE="%s"\n' "$proxy_mode"
  printf 'RISULTA_MAX_OPEN_SITES="32"\n'
  if [ "$fresh_install" -eq 1 ]; then
    printf 'RISULTA_ADMIN_EMAIL="%s"\n' "$(env_quote "$admin_email")"
    printf 'RISULTA_ADMIN_PASSWORD="%s"\n' "$(env_quote "$admin_password")"
  fi
} > "$env_tmp"
install -m 0600 "$env_tmp" "$ENV_FILE"
umask "$previous_umask"

cat > "$SERVICE_FILE" <<'UNIT'
[Unit]
Description=Risulta web analytics
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=risulta
Group=risulta
EnvironmentFile=/etc/risulta/risulta.env
ExecStart=/usr/local/bin/risulta
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
StateDirectory=risulta
WorkingDirectory=/var/lib/risulta
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/risulta

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable risulta
systemctl restart risulta

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  systemctl status risulta --no-pager >&2 || true
  fail "Risulta did not become healthy. Review: journalctl -u risulta"
fi

if [ "$fresh_install" -eq 1 ]; then
  credentials_free="$tmp_dir/risulta.env.clean"
  grep -v '^RISULTA_ADMIN_' "$ENV_FILE" > "$credentials_free"
  install -m 0600 "$credentials_free" "$ENV_FILE"
  admin_password=""
  admin_password_again=""
  systemctl restart risulta
fi

if [ "$use_caddy" -eq 1 ]; then
  install -d -m 0755 /etc/caddy/sites
  caddy_site="/etc/caddy/sites/risulta.caddy"
  caddy_site_tmp="$tmp_dir/risulta.caddy"
  {
    printf '%s {\n' "$domain"
    printf '\tencode zstd gzip\n'
    printf '\treverse_proxy 127.0.0.1:%s\n' "$PORT"
    printf '}\n'
  } > "$caddy_site_tmp"
  install -m 0644 "$caddy_site_tmp" "$caddy_site"
  if [ ! -f /etc/caddy/Caddyfile ]; then
    caddyfile_tmp="$tmp_dir/Caddyfile"
    printf 'import sites/*\n' > "$caddyfile_tmp"
    install -m 0644 "$caddyfile_tmp" /etc/caddy/Caddyfile
  elif ! grep -Eq '^[[:space:]]*import[[:space:]]+sites/\*' /etc/caddy/Caddyfile; then
    printf '\nimport sites/*\n' >> /etc/caddy/Caddyfile
  fi

  if ! command -v caddy >/dev/null 2>&1; then
    say ""
    say "Caddy is not installed. Installing the official stable package…"
    command -v apt-get >/dev/null 2>&1 || fail "Automatic Caddy installation currently supports Debian and Ubuntu. Install Caddy, then run this script again."
    apt-get update
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update
    if [ ! -e /usr/sbin/policy-rc.d ]; then
      # Prevent the package post-install hook from starting Caddy before the
      # validated Risulta configuration is ready.
      printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
      chmod 0755 /usr/sbin/policy-rc.d
      policy_created=1
    fi
    if ! DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold install -y caddy; then
      fail "The Caddy package could not be installed. Risulta remains available on 127.0.0.1:$PORT."
    fi
    if [ "$policy_created" -eq 1 ]; then rm -f /usr/sbin/policy-rc.d; policy_created=0; fi
  fi

  caddy validate --config /etc/caddy/Caddyfile
  systemctl enable caddy
  if ! systemctl reload-or-restart caddy; then caddy_failure; fi
fi

say ""
say "Risulta is ready."
say "Dashboard: $base_url"
case "$proxy_mode" in
  caddy)
    say "HTTPS: Caddy configured through its official package and systemd service."
    say "Make sure the DNS A/AAAA record for $domain points to this server."
    ;;
  existing)
    say "HTTPS: connect your existing host proxy to http://127.0.0.1:$PORT"
    say "Set Host to the original host and X-Forwarded-Proto to https."
    say "Caddyfile example:"
    say "$domain {"
    say "    reverse_proxy 127.0.0.1:$PORT"
    say "}"
    say "If your proxy runs in Docker, use a full Docker deployment instead; container localhost cannot reach this host service."
    ;;
  direct)
    say "HTTPS: not configured; Risulta is listening on $listen_host:$PORT"
    say "Use this only on a private network or add a TLS reverse proxy before public use."
    ;;
esac
say "Service status: systemctl status risulta"
say "Logs: journalctl -u risulta"
