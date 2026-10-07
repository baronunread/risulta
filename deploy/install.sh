#!/bin/sh
set -eu

REPOSITORY="${RISULTA_REPOSITORY:-baronunread/risulta}"
INSTALL_PATH="/usr/local/bin/risulta-sprout"
ROLLUP_LIB_DIR="/usr/local/lib/risulta-sprout"
ROLLUP_SERVICE_FILE="/etc/systemd/system/risulta-rollups.service"
ROLLUP_TIMER_FILE="/etc/systemd/system/risulta-rollups.timer"
ENV_DIR="/etc/risulta-sprout"
ENV_FILE="$ENV_DIR/risulta-sprout.env"
DATA_DIR="/var/lib/risulta-sprout"
SERVICE_FILE="/etc/systemd/system/risulta-sprout.service"
BACKUP_ROOT="/var/backups/risulta-sprout"
PORT="${RISULTA_PORT:-}"
STATE_FILE="$ENV_DIR/release.env"
channel=""
version=""
update_only=0

say() { printf '%s\n' "$*"; }
fail() { say "Error: $*" >&2; exit 1; }
usage() {
  say "Usage: sh install.sh [--update] [--channel stable|nightly] [--version TAG]"
  say "Stable is the default. Updates reuse the saved channel and settings."
  say "An exact version applies once and does not change the saved channel."
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --update) update_only=1; shift ;;
    --channel) [ "$#" -ge 2 ] && [ -n "$2" ] || fail "--channel needs stable or nightly."; channel="$2"; shift 2 ;;
    --version) [ "$#" -ge 2 ] && [ -n "$2" ] || fail "--version needs a release tag."; version="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$channel" in ""|stable|nightly) ;; *) fail "Unknown release channel: $channel" ;; esac
[ -z "$version" ] || [ -z "$channel" ] || fail "Choose --channel or --version, not both."
case "$version" in *[!A-Za-z0-9._-]*) fail "Invalid release tag." ;; esac
step() {
  label="$1"; shift
  log="$tmp_dir/step.log"
  if [ -t 1 ]; then
    "$@" >"$log" 2>&1 & pid=$!
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
      *.[Uu][Tt][Ff]-8*|*[Uu][Tt][Ff]8*) frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' ;;
      *) frames='-|/' ;;
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
  sed -n "s/^${key}=\"\(.*\)\"$/\1/p; s/^${key}=\([^\"].*\)$/\1/p" "$ENV_FILE" | tail -n 1
}
release_setting() {
  [ -r "$STATE_FILE" ] || return 0
  sed -n "s/^${1}=\"\([^\"]*\)\"$/\1/p" "$STATE_FILE" | tail -n 1
}
save_release_state() {
  install -d -m 0750 "$ENV_DIR"
  {
    printf 'CHANNEL="%s"\n' "$selected_channel"
    printf 'TAG="%s"\n' "$release_tag"
    printf 'COMMIT="%s"\n' "$release_commit"
    printf 'REPOSITORY="%s"\n' "$REPOSITORY"
  } > "$tmp_dir/release.env"
  install -m 0600 "$tmp_dir/release.env" "$STATE_FILE.new"
  mv -f "$STATE_FILE.new" "$STATE_FILE"
}
wait_healthy() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if systemctl is-active --quiet risulta-sprout && curl -fsS -D "$tmp_dir/health.headers" "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      healthy_schema="$(awk 'tolower($1) == "x-risulta-schema-version:" { gsub("\r", "", $2); print $2 }' "$tmp_dir/health.headers")"
      if [ "${rollup_schema_version:-0}" -eq 0 ] || [ "$healthy_schema" = "$rollup_schema_version" ]; then return 0; fi
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
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
if [ "$update_only" -eq 0 ]; then
  [ -r /dev/tty ] || fail "An interactive terminal is required. Download the script first if needed."
else
  [ -x "$INSTALL_PATH" ] && [ -r "$ENV_FILE" ] && [ -r "$SERVICE_FILE" ] || fail "--update requires an existing installation."
  saved_data_dir="$(saved_setting SB_DATA_DIR)"
  if [ -n "$saved_data_dir" ]; then DATA_DIR="$saved_data_dir"; fi
  [ -f "$DATA_DIR/d1/DB.sqlite" ] || fail "--update requires an existing Risulta database."
  PORT="$(saved_setting PORT)"
  case "$PORT" in ""|*[!0-9]*) fail "The saved PORT is invalid." ;; esac
  [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "The saved PORT is invalid."
fi
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v python3 >/dev/null 2>&1 || fail "python3 is required to read GitHub release metadata."
command -v systemctl >/dev/null 2>&1 || fail "Risulta currently requires a systemd-based Linux server."

case "$(uname -s)" in Linux) ;; *) fail "Only Linux servers are supported by this installer." ;; esac
case "$(uname -m)" in
  x86_64|amd64) artifact="risulta-sprout-linux-x64" ;;
  aarch64|arm64) artifact="risulta-sprout-linux-arm64" ;;
  *) fail "Unsupported CPU architecture: $(uname -m)" ;;
esac

say ""
say "Risulta installer"
say "Private web analytics in one binary."
say ""

tmp_dir="$(mktemp -d /tmp/risulta-sprout-install.XXXXXX)"
policy_created=0
service_stopped=0
binary_replaced=0
backup_target=""
rollups_timer_paused=0
rollups_service_paused=0
pause_rollups() {
  if systemctl is-active --quiet risulta-rollups.timer 2>/dev/null; then
    systemctl stop risulta-rollups.timer
    rollups_timer_paused=1
  fi
  if systemctl is-active --quiet risulta-rollups.service 2>/dev/null; then
    systemctl stop risulta-rollups.service
    rollups_service_paused=1
  fi
}
backup_rollup_files() {
  if [ -r "$ROLLUP_LIB_DIR/rollup-runner.py" ]; then install -m 0600 "$ROLLUP_LIB_DIR/rollup-runner.py" "$backup_target/rollup-runner.py"; fi
  if [ -r "$ROLLUP_SERVICE_FILE" ]; then install -m 0600 "$ROLLUP_SERVICE_FILE" "$backup_target/risulta-rollups.service"; fi
  if [ -r "$ROLLUP_TIMER_FILE" ]; then install -m 0600 "$ROLLUP_TIMER_FILE" "$backup_target/risulta-rollups.timer"; fi
}
cleanup() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$service_stopped" -eq 1 ]; then
    if [ "$binary_replaced" -eq 0 ]; then
      systemctl start risulta-sprout || true
    else
      systemctl stop risulta-sprout || true
      systemctl stop risulta-rollups.timer || true
      systemctl stop risulta-rollups.service || true
      say "Update failed. Recovery files: $backup_target" >&2
      say "Keep the database backup paired with its previous executable when restoring." >&2
    fi
  fi
  # Resume jobs only after success, or before any executable replacement.
  # A failed schema upgrade must keep all writers stopped for paired recovery.
  if [ "$code" -eq 0 ] || [ "$binary_replaced" -eq 0 ]; then
    if [ "$rollups_timer_paused" -eq 1 ]; then systemctl start risulta-rollups.timer || true; fi
    if [ "$rollups_service_paused" -eq 1 ] && [ "$rollups_timer_paused" -eq 0 ]; then systemctl start risulta-rollups.service || true; fi
  fi
  if [ "$policy_created" -eq 1 ]; then rm -f /usr/sbin/policy-rc.d; fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT HUP INT TERM

if [ "$update_only" -eq 1 ]; then
  command -v flock >/dev/null 2>&1 || fail "flock is required for updates. Install the util-linux package."
  exec 9> "$ENV_DIR/install.lock"
  flock -n 9 || fail "Another Risulta update is already running."
fi

selected_channel="${channel:-$(release_setting CHANNEL)}"
selected_channel="${selected_channel:-stable}"
case "$selected_channel" in stable|nightly) ;; *) fail "The saved release channel is invalid." ;; esac
if [ -n "$version" ]; then
  release_tag="$version"
elif [ "$selected_channel" = nightly ]; then
  curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$REPOSITORY/releases?per_page=100" -o "$tmp_dir/releases.json"
  release_tag="$(python3 -c 'import json,sys; releases=json.load(open(sys.argv[1])); candidates=[r for r in releases if not r.get("draft") and r.get("prerelease") and str(r.get("tag_name", "")).startswith("nightly-")]; candidates.sort(key=lambda r: r.get("published_at") or "", reverse=True); print(candidates[0]["tag_name"] if candidates else "")' "$tmp_dir/releases.json")"
else
  curl --proto '=https' --tlsv1.2 -fsSL "https://api.github.com/repos/$REPOSITORY/releases/latest" -o "$tmp_dir/release.json"
  release_tag="$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert not r.get("draft") and not r.get("prerelease"); print(r["tag_name"])' "$tmp_dir/release.json")"
fi
case "$release_tag" in ""|*[!A-Za-z0-9._-]*) fail "No valid release found for $selected_channel." ;; esac
download_base="https://github.com/$REPOSITORY/releases/download/$release_tag"
release_commit="unknown"
rollup_schema_version=0
if curl --proto '=https' --tlsv1.2 -fsSL "$download_base/release.json" -o "$tmp_dir/release.json" 2>/dev/null; then
  metadata_tag="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag"])' "$tmp_dir/release.json")"
  release_commit="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$tmp_dir/release.json")"
  rollup_schema_version="$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("rollup_schema_version",0); assert isinstance(v,int) and 0<=v<=100000; print(v)' "$tmp_dir/release.json")"
  [ "$metadata_tag" = "$release_tag" ] || fail "Release metadata tag mismatch."
  case "$release_commit" in ""|*[!a-f0-9]*) fail "Invalid release commit." ;; esac
  [ "${#release_commit}" -eq 40 ] || fail "Invalid release commit length."
else
  case "$release_tag" in nightly-*) fail "Nightly release metadata is missing." ;; esac
fi
say "Installed: $(release_setting TAG)"
say "Target: $release_tag ($release_commit), channel $selected_channel"

say ""
step "Downloading checksum" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$artifact.sha256" -o "$tmp_dir/$artifact.sha256"
expected_hash="$(awk '{print $1}' "$tmp_dir/$artifact.sha256")"
case "$expected_hash" in ""|*[!a-fA-F0-9]*) fail "The checksum file is invalid." ;; esac
[ "${#expected_hash}" -eq 64 ] || fail "The checksum file is invalid."
installed_hash=""
if [ -x "$INSTALL_PATH" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    installed_hash="$(sha256sum "$INSTALL_PATH" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    installed_hash="$(shasum -a 256 "$INSTALL_PATH" | awk '{print $1}')"
  fi
fi
download_rollups() {
  [ "$rollup_schema_version" -gt 0 ] || return 0
  for helper in rollup-runner.py risulta-rollups.service risulta-rollups.timer; do
    step "Downloading $helper" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$helper" -o "$tmp_dir/$helper"
    step "Downloading $helper checksum" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$helper.sha256" -o "$tmp_dir/$helper.sha256"
    helper_expected="$(awk '{print $1}' "$tmp_dir/$helper.sha256")"
    case "$helper_expected" in ""|*[!a-fA-F0-9]*) fail "The $helper checksum is invalid." ;; esac
    [ "${#helper_expected}" -eq 64 ] || fail "The $helper checksum is invalid."
    if command -v sha256sum >/dev/null 2>&1; then
      helper_actual="$(sha256sum "$tmp_dir/$helper" | awk '{print $1}')"
    else
      helper_actual="$(shasum -a 256 "$tmp_dir/$helper" | awk '{print $1}')"
    fi
    [ "$helper_actual" = "$helper_expected" ] || fail "The $helper download failed checksum verification."
  done
}
install_rollups() {
  [ "$rollup_schema_version" -gt 0 ] || return 0
  wait_healthy || fail "The upgraded database schema is not ready for rollups."
  install -d -m 0755 "$ROLLUP_LIB_DIR"
  install -m 0755 "$tmp_dir/rollup-runner.py" "$ROLLUP_LIB_DIR/rollup-runner.py.new"
  mv -f "$ROLLUP_LIB_DIR/rollup-runner.py.new" "$ROLLUP_LIB_DIR/rollup-runner.py"
  install -m 0644 "$tmp_dir/risulta-rollups.service" "$ROLLUP_SERVICE_FILE"
  install -m 0644 "$tmp_dir/risulta-rollups.timer" "$ROLLUP_TIMER_FILE"
  systemctl daemon-reload
  systemctl enable --now risulta-rollups.timer
  say "Daily rollups enabled. Historical backfill runs in bounded batches."
}
download_rollups

if [ -n "$installed_hash" ] && [ "$installed_hash" = "$expected_hash" ]; then
  if [ "$rollup_schema_version" -gt 0 ]; then
    wait_healthy || fail "Start Risulta before enabling rollups."
    install_rollups
  fi
  save_release_state
  say "Risulta is up to date."
  exit 0
fi

download_binary() {
  step "Downloading $artifact" curl --proto '=https' --tlsv1.2 -fsSL "$download_base/$artifact" -o "$tmp_dir/$artifact"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash="$(sha256sum "$tmp_dir/$artifact" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash="$(shasum -a 256 "$tmp_dir/$artifact" | awk '{print $1}')"
  else
    fail "sha256sum or shasum is required to verify the download."
  fi
  [ "$actual_hash" = "$expected_hash" ] || fail "The downloaded binary failed checksum verification."
  say "Checksum verified"
}

if [ "$update_only" -eq 1 ]; then
  download_binary
  install -d -m 0750 "$BACKUP_ROOT"
  backup_target="$(mktemp -d "$BACKUP_ROOT/pre-update-$(date +%F-%H%M%S)-XXXXXX")"
  install -m 0755 "$INSTALL_PATH" "$backup_target/risulta-sprout"
  install -m 0600 "$ENV_FILE" "$backup_target/risulta-sprout.env"
  if [ -r "$STATE_FILE" ]; then install -m 0600 "$STATE_FILE" "$backup_target/release.env"; fi
  # Stage on the destination filesystem for an atomic executable replacement.
  install -m 0755 "$tmp_dir/$artifact" "$INSTALL_PATH.new"
  pause_rollups
  if systemctl is-active --quiet risulta-sprout; then
    step "Stopping Risulta for a safety backup" systemctl stop risulta-sprout
    service_stopped=1
  fi
  step "Creating safety backup" cp -a "$DATA_DIR" "$backup_target/data"
  backup_rollup_files
  say "Recovery files: $backup_target"
  mv -f "$INSTALL_PATH.new" "$INSTALL_PATH"
  binary_replaced=1
  systemctl restart risulta-sprout
  service_stopped=1
  if ! wait_healthy; then
    systemctl status risulta-sprout --no-pager >&2 || true
    fail "Risulta did not become healthy. Review: journalctl -u risulta-sprout"
  fi
  install_rollups
  save_release_state
  service_stopped=0
  say "Updated to $release_tag. Dashboard: $(saved_setting RISULTA_BASE_URL)"
  exit 0
fi

fresh_install=1
if [ -f "$DATA_DIR/d1/DB.sqlite" ]; then
  fresh_install=0
  say "Existing Risulta data found. It will be kept, and the administrator will not be replaced."
fi

saved_base_url="$(saved_setting RISULTA_BASE_URL)"
saved_proxies="$(saved_setting SB_TRUSTED_PROXIES)"
saved_proxy_mode="$(saved_setting RISULTA_PROXY_MODE)"
saved_port="$(saved_setting PORT)"
saved_log_level="$(saved_setting RISULTA_LOG_LEVEL)"
[ -n "$PORT" ] || PORT="${saved_port:-8099}"
case "$saved_proxy_mode" in
  caddy|existing|direct) ;;
  *) if [ -n "$saved_proxies" ]; then saved_proxy_mode=caddy; else saved_proxy_mode=direct; fi ;;
esac

saved_domain=""
case "$saved_base_url" in
  https://*) saved_domain="${saved_base_url#https://}" ;;
  http://*) saved_domain="${saved_base_url#http://}"; saved_domain="${saved_domain%:"$PORT"}" ;;
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
  admin_display_name="$(prompt "Administrator display name" "${admin_email%%@*}")"
  admin_password="$(secret "Administrator password (12 characters or more)")"
  [ "${#admin_password}" -ge 12 ] || fail "The administrator password must contain at least 12 characters."
  admin_password_again="$(secret "Confirm administrator password")"
  [ "$admin_password" = "$admin_password_again" ] || fail "The passwords do not match."
fi

case "$proxy_mode" in
  caddy) base_url="https://$domain"; trusted_proxies="127.0.0.1"; use_caddy=1 ;;
  existing) base_url="https://$domain"; trusted_proxies="127.0.0.1"; use_caddy=0 ;;
  direct) base_url="http://$domain:$PORT"; trusted_proxies=""; use_caddy=0 ;;
  *) fail "Unknown proxy mode: $proxy_mode" ;;
esac

say ""
download_binary

if [ "$fresh_install" -eq 0 ]; then
  install -d -m 0750 "$BACKUP_ROOT"
  backup_target="$BACKUP_ROOT/pre-update-$(date +%F-%H%M%S)"
  pause_rollups
  if systemctl is-active --quiet risulta-sprout 2>/dev/null; then
    step "Stopping Risulta for a safety backup" systemctl stop risulta-sprout
    service_stopped=1
  fi
  step "Creating safety backup" cp -r "$DATA_DIR" "$backup_target"
  backup_rollup_files
  if [ -x "$INSTALL_PATH" ]; then install -m 0755 "$INSTALL_PATH" "$backup_target/previous-executable"; fi
  say "Safety backup at $backup_target"
fi

if ! id risulta-sprout >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin risulta-sprout
fi
install -d -m 0750 -o risulta-sprout -g risulta-sprout "$DATA_DIR" "$ENV_DIR"
install -m 0755 "$tmp_dir/$artifact" "$INSTALL_PATH.new"
mv -f "$INSTALL_PATH.new" "$INSTALL_PATH"
binary_replaced=1

previous_umask="$(umask)"
umask 077
env_tmp="$tmp_dir/risulta-sprout.env"
{
  printf 'PORT="%s"\n' "$(env_quote "$PORT")"
  printf 'SB_DATA_DIR="%s"\n' "$(env_quote "$DATA_DIR")"
  printf 'RISULTA_BASE_URL="%s"\n' "$(env_quote "$base_url")"
  printf 'SB_TRUSTED_PROXIES="%s"\n' "$(env_quote "$trusted_proxies")"
  printf 'RISULTA_PROXY_MODE="%s"\n' "$proxy_mode"
  if [ -n "$saved_log_level" ]; then
    printf 'RISULTA_LOG_LEVEL="%s"\n' "$(env_quote "$saved_log_level")"
  fi
  if [ "$fresh_install" -eq 1 ]; then
    printf 'RISULTA_ADMIN_EMAIL="%s"\n' "$(env_quote "$admin_email")"
    printf 'RISULTA_ADMIN_DISPLAY_NAME="%s"\n' "$(env_quote "$admin_display_name")"
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
User=risulta-sprout
Group=risulta-sprout
UMask=0077
EnvironmentFile=/etc/risulta-sprout/risulta-sprout.env
ExecStart=/usr/local/bin/risulta-sprout
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
StateDirectory=risulta-sprout
WorkingDirectory=/var/lib/risulta-sprout
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/risulta-sprout

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable risulta-sprout
systemctl restart risulta-sprout

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ready=1; break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  systemctl status risulta-sprout --no-pager >&2 || true
  fail "Risulta did not become healthy. Review: journalctl -u risulta-sprout"
fi

if [ "$fresh_install" -eq 1 ]; then
  credentials_free="$tmp_dir/risulta-sprout.env.clean"
  grep -v '^RISULTA_ADMIN_' "$ENV_FILE" > "$credentials_free"
  install -m 0600 "$credentials_free" "$ENV_FILE"
  admin_password=""
  admin_password_again=""
  systemctl restart risulta-sprout
fi

if [ "$use_caddy" -eq 1 ]; then
  install -d -m 0755 /etc/caddy/sites
  caddy_site="/etc/caddy/sites/risulta-sprout.caddy"
  caddy_site_tmp="$tmp_dir/risulta-sprout.caddy"
  {
    printf '%s {\n' "$domain"
    printf '\tencode zstd gzip\n'
    printf '\treverse_proxy 127.0.0.1:%s {\n' "$PORT"
    printf '\t\theader_up X-Forwarded-For {http.request.remote.host}\n'
    printf '\t}\n'
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
install_rollups
save_release_state
service_stopped=0
say "Dashboard: $base_url"
case "$proxy_mode" in
  caddy)
    say "HTTPS: Caddy configured through its official package and systemd service."
    say "Make sure the DNS A/AAAA record for $domain points to this server."
    ;;
  existing)
    say "HTTPS: connect your existing host proxy to http://127.0.0.1:$PORT"
    say "Set Host to the original host and overwrite X-Forwarded-For with the client address."
    say "Caddyfile example:"
    say "$domain {"
    say "    reverse_proxy 127.0.0.1:$PORT {"
    say "        header_up X-Forwarded-For {http.request.remote.host}"
    say "    }"
    say "}"
    ;;
  direct)
    say "HTTPS: not configured; Risulta is listening on 0.0.0.0:$PORT"
    say "Use this only on a private network or add a TLS reverse proxy before public use."
    ;;
esac
say "Service status: systemctl status risulta-sprout"
say "Logs: journalctl -u risulta-sprout"
