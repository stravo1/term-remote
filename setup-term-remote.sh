#!/usr/bin/env bash
#
# Provision the browser terminal: ttyd behind Caddy forward-auth + Authelia.
#
# Host settings come from the settings file, from the environment, or from the
# defaults below. The defaults are placeholders and the script refuses to run
# against them, so a real host always sets values, usually through the file.
#
# Everything this script owns is wrapped in "managed by setup-term-remote.sh"
# markers, so re-running it replaces those blocks and leaves the rest alone.
#
# Usage: ./setup-term-remote.sh [--force]
#
#   --force   rewrite the ttyd unit even if it is not script-managed
#
# Settings file: ~/.config/term-remote/env, one KEY=VALUE per line, no quotes.
# The environment wins over the file, and the file wins over the defaults.
#
#   TERM_REMOTE_DOMAIN         public hostname                 (term.example.com)
#   AUTHELIA_PORTAL_DOMAIN     portal hostname                 (auth.example.com)
#   AUTHELIA_POLICY            access control policy           (two_factor)
#   TERM_REMOTE_PORT           ttyd loopback port              (7681)
#   TERM_REMOTE_MAX_CLIENTS    concurrent clients              (4)
#   TERM_REMOTE_TMUX_SESSION   tmux session clients attach to  (main)
#   TTYD_VERSION               ttyd release tag                (ttyd.version)
#   CADDY_CONFIG               Caddyfile path                  (~/.config/caddy/Caddyfile)
#   AUTHELIA_CONFIG            Authelia configuration path     (~/.config/authelia/configuration.yml)
#   AUTHELIA_PORT              Authelia listen port            (9091)
#   CADDY_ADMIN                Caddy admin API                 (http://127.0.0.1:2019)
#   APP_ROOT                   frontend install directory      (~/.local/share/term-remote/app)
#   TERM_REMOTE_ENV            alternative settings file path
#   CADDY_BINARY               caddy executable                (resolved from PATH)
#   AUTHELIA_BINARY            authelia executable             (resolved from PATH)
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly TEMPLATE_DIR="${SCRIPT_DIR}/templates"
readonly APP_SOURCE="${SCRIPT_DIR}/app"
readonly BIN_DIR="${HOME}/.local/bin"
readonly UNIT_DIR="${HOME}/.config/systemd/user"
readonly UNIT_PATH="${UNIT_DIR}/ttyd.service"
readonly UNIT_MARKER="managed-by: setup-term-remote.sh"
readonly LEGACY_UNIT_MARKER="managed-by: setup-web-terminal.sh"
readonly HOST_ENV_FILE="${TERM_REMOTE_ENV:-${XDG_CONFIG_HOME:-${HOME}/.config}/term-remote/env}"
readonly MARKER_START="# >>> term-remote"
readonly MARKER_STOP="# <<< term-remote"
# Blocks written before the rename are still stripped, so older hosts migrate.
readonly LEGACY_MARKER_START="# >>> web-terminal"
readonly LEGACY_MARKER_STOP="# <<< web-terminal"

log() { printf '[term-remote] %s\n' "$*"; }
fail() {
	printf '[term-remote] error: %s\n' "$*" >&2
	exit 1
}

# One KEY=VALUE per line, no quotes. Values already set in the environment win.
load_host_settings() {
	local line name
	[[ -f $HOST_ENV_FILE ]] || return 0
	while IFS= read -r line || [[ -n $line ]]; do
		[[ $line =~ ^[[:space:]]*(#|$) ]] && continue
		name="${line%%=*}"
		[[ $name =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
		[[ -n ${!name+set} ]] && continue
		export "${line?}"
	done <"$HOST_ENV_FILE"
}

load_host_settings

DOMAIN="${TERM_REMOTE_DOMAIN:-term.example.com}"
PORTAL_DOMAIN="${AUTHELIA_PORTAL_DOMAIN:-auth.example.com}"
POLICY="${AUTHELIA_POLICY:-two_factor}"
PORT="${TERM_REMOTE_PORT:-7681}"
MAX_CLIENTS="${TERM_REMOTE_MAX_CLIENTS:-4}"
TMUX_SESSION="${TERM_REMOTE_TMUX_SESSION:-main}"
TTYD_VERSION="${TTYD_VERSION:-$(<"${SCRIPT_DIR}/ttyd.version")}"
CADDY_CONFIG="${CADDY_CONFIG:-${HOME}/.config/caddy/Caddyfile}"
AUTHELIA_CONFIG="${AUTHELIA_CONFIG:-${HOME}/.config/authelia/configuration.yml}"
AUTHELIA_PORT="${AUTHELIA_PORT:-9091}"
CADDY_ADMIN="${CADDY_ADMIN:-http://127.0.0.1:2019}"
APP_ROOT="${APP_ROOT:-${XDG_DATA_HOME:-${HOME}/.local/share}/term-remote/app}"
CADDY_BINARY="${CADDY_BINARY:-}"
AUTHELIA_BINARY="${AUTHELIA_BINARY:-}"

FORCE=0
UNIT_CHANGED=0
AUTHELIA_CHANGED=0
CADDY_CHANGED=0

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

usage() {
	awk 'NR == 1 { next } /^set -euo/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
}

parse_arguments() {
	while (($# > 0)); do
		case "$1" in
			--force) FORCE=1 ;;
			--help | -h)
				usage
				exit 0
				;;
			*) fail "unknown argument: $1 (try --help)" ;;
		esac
		shift
	done
}

is_placeholder_domain() {
	[[ $1 == example.com || $1 == *.example.com ]]
}

require_settings() {
	local missing=""
	if is_placeholder_domain "$DOMAIN"; then
		missing="TERM_REMOTE_DOMAIN"
	fi
	if is_placeholder_domain "$PORTAL_DOMAIN"; then
		missing="${missing:+${missing} and }AUTHELIA_PORTAL_DOMAIN"
	fi
	if [[ -n $missing ]]; then
		fail "no real hostname configured; set ${missing} or write settings to ${HOST_ENV_FILE}"
	fi
}

resolve_binary() {
	local name=$1 override=$2
	if [[ -n $override ]]; then
		printf '%s\n' "$override"
		return
	fi
	command -v "$name" || fail "$name not found in PATH; set ${name^^}_BINARY"
}

require_commands() {
	local missing=0 binary
	for binary in curl tmux systemctl awk sed cmp; do
		command -v "$binary" >/dev/null 2>&1 || {
			log "missing command: $binary"
			missing=1
		}
	done
	((missing == 0)) || fail "install the commands above and re-run"

	CADDY_BINARY="$(resolve_binary caddy "$CADDY_BINARY")"
	AUTHELIA_BINARY="$(resolve_binary authelia "$AUTHELIA_BINARY")"

	[[ -f $CADDY_CONFIG ]] || fail "Caddyfile not found: ${CADDY_CONFIG}"
	[[ -f $AUTHELIA_CONFIG ]] || fail "Authelia config not found: ${AUTHELIA_CONFIG}"
	systemctl --user show-environment >/dev/null 2>&1 ||
		fail "user systemd is not available for ${USER}"
}

ttyd_asset() {
	case "$(uname -m)" in
		x86_64 | amd64) printf 'ttyd.x86_64\n' ;;
		aarch64 | arm64) printf 'ttyd.aarch64\n' ;;
		*) fail "unsupported architecture: $(uname -m)" ;;
	esac
}

install_ttyd() {
	local target="${BIN_DIR}/ttyd" asset url download

	if [[ -x $target && $FORCE -eq 0 ]]; then
		log "ttyd already installed: $("$target" --version 2>/dev/null || echo unknown)"
		return
	fi

	asset="$(ttyd_asset)"
	url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}"
	download="${WORK_DIR}/${asset}"

	log "downloading ${url}"
	curl -fsSL --retry 3 --max-time 180 -o "$download" "$url" ||
		fail "download failed: ${url}"

	chmod 0755 "$download"
	"$download" --version >/dev/null 2>&1 ||
		fail "downloaded binary does not run (wrong architecture or broken release)"

	install -m 0755 -D "$download" "$target"
	log "installed $("$target" --version)"
}

render_template() {
	local template=$1 destination=$2
	sed \
		-e "s|@DOMAIN@|${DOMAIN}|g" \
		-e "s|@POLICY@|${POLICY}|g" \
		-e "s|@PORT@|${PORT}|g" \
		-e "s|@AUTHELIA_PORT@|${AUTHELIA_PORT}|g" \
		-e "s|@TTYD_BINARY@|${BIN_DIR}/ttyd|g" \
		-e "s|@APP_ROOT@|${APP_ROOT}|g" \
		-e "s|@WORKDIR@|${HOME}|g" \
		-e "s|@MAX_CLIENTS@|${MAX_CLIENTS}|g" \
		-e "s|@TMUX_SESSION@|${TMUX_SESSION}|g" \
		"$template" >"$destination"
}

backup_file() {
	local path=$1 backup
	[[ -f $path ]] || return 0
	backup="${path}.bak.$(date +%s)"
	cp -- "$path" "$backup"
	printf '%s\n' "$backup"
}

install_unit() {
	local rendered="${WORK_DIR}/ttyd.service"
	render_template "${TEMPLATE_DIR}/ttyd.service.in" "$rendered"

	if [[ -f $UNIT_PATH ]] && cmp -s "$rendered" "$UNIT_PATH"; then
		log "unit unchanged: ${UNIT_PATH}"
		return
	fi
	if [[ -f $UNIT_PATH ]] && ! grep -qE "${UNIT_MARKER}|${LEGACY_UNIT_MARKER}" "$UNIT_PATH" && ((FORCE == 0)); then
		fail "${UNIT_PATH} exists but is not managed by this script; re-run with --force"
	fi

	backup_file "$UNIT_PATH" >/dev/null
	mkdir -p "$UNIT_DIR"
	install -m 0644 "$rendered" "$UNIT_PATH"
	UNIT_CHANGED=1
	log "wrote unit: ${UNIT_PATH}"
}

install_app() {
	[[ -d $APP_SOURCE ]] || fail "frontend directory missing: ${APP_SOURCE}"

	if diff -rq -- "$APP_SOURCE" "$APP_ROOT" >/dev/null 2>&1; then
		log "frontend unchanged: ${APP_ROOT}"
		return
	fi

	mkdir -p "$APP_ROOT"
	find "$APP_ROOT" -mindepth 1 -delete
	cp -a -- "${APP_SOURCE}/." "$APP_ROOT/"
	log "deployed frontend: ${APP_ROOT}"
}

strip_marker_block() {
	local source=$1 destination=$2
	awk \
		-v start="$MARKER_START" -v stop="$MARKER_STOP" \
		-v legacy_start="$LEGACY_MARKER_START" -v legacy_stop="$LEGACY_MARKER_STOP" '
		index($0, start) || index($0, legacy_start) { skipping = 1; next }
		index($0, stop) || index($0, legacy_stop)  { skipping = 0; next }
		!skipping
	' "$source" >"$destination"
}

find_rules_line() {
	awk '
		/^access_control:/ { inside = 1; next }
		inside && /^[^[:space:]#]/ { exit }
		inside && /^[[:space:]]+rules:/ { print NR; exit }
	' "$1"
}

insert_after_line() {
	local source=$1 line=$2 snippet=$3 destination=$4
	awk -v line="$line" -v snippet="$snippet" '
		NR == line {
			print
			while ((getline extra < snippet) > 0) print extra
			close(snippet)
			next
		}
		{ print }
	' "$source" >"$destination"
}

trim_trailing_blank_lines() {
	local file=$1 temporary="${1}.trim"
	awk '
		{ line[NR] = $0 }
		END {
			last = NR
			while (last > 0 && line[last] ~ /^[[:space:]]*$/) last--
			for (i = 1; i <= last; i++) print line[i]
		}
	' "$file" >"$temporary"
	mv -- "$temporary" "$file"
}

patch_authelia() {
	local stripped="${WORK_DIR}/authelia-stripped.yml"
	local candidate="${WORK_DIR}/authelia.yml"
	local snippet="${WORK_DIR}/authelia-rule.yml"
	local anchor backup

	render_template "${TEMPLATE_DIR}/authelia-rule.yml.in" "$snippet"
	strip_marker_block "$AUTHELIA_CONFIG" "$stripped"
	anchor="$(find_rules_line "$stripped")"
	[[ -n $anchor ]] ||
		fail "no access_control.rules block in ${AUTHELIA_CONFIG}; add the rule by hand"

	if grep -qE "^[[:space:]]*- domain: '?${DOMAIN}'?[[:space:]]*$" "$stripped"; then
		fail "${AUTHELIA_CONFIG} already has a rule for ${DOMAIN} outside the managed block; remove it and re-run"
	fi

	insert_after_line "$stripped" "$anchor" "$snippet" "$candidate"
	if cmp -s "$candidate" "$AUTHELIA_CONFIG"; then
		log "authelia rule unchanged: ${DOMAIN} (${POLICY})"
		return
	fi

	backup="$(backup_file "$AUTHELIA_CONFIG")"
	install -m 0644 "$candidate" "$AUTHELIA_CONFIG"
	if ! "$AUTHELIA_BINARY" validate-config --config "$AUTHELIA_CONFIG" >/dev/null 2>&1; then
		install -m 0644 "$backup" "$AUTHELIA_CONFIG"
		fail "authelia rejected the generated config; restored ${backup}"
	fi
	AUTHELIA_CHANGED=1
	log "added authelia rule: ${DOMAIN} (${POLICY})"
}

patch_caddy() {
	local stripped="${WORK_DIR}/Caddyfile.stripped"
	local candidate="${WORK_DIR}/Caddyfile"
	local snippet="${WORK_DIR}/caddy-block.caddyfile"
	local backup

	render_template "${TEMPLATE_DIR}/caddy-block.caddyfile.in" "$snippet"
	strip_marker_block "$CADDY_CONFIG" "$stripped"

	if grep -qE "^${DOMAIN//./\\.}[[:space:]]*\{" "$stripped"; then
		fail "${CADDY_CONFIG} already has a site block for ${DOMAIN} outside the managed block; remove it and re-run"
	fi

	cp -- "$stripped" "$candidate"
	trim_trailing_blank_lines "$candidate"
	printf '\n' >>"$candidate"
	cat "$snippet" >>"$candidate"

	if cmp -s "$candidate" "$CADDY_CONFIG"; then
		log "caddy site unchanged: ${DOMAIN}"
		return
	fi

	backup="$(backup_file "$CADDY_CONFIG")"
	install -m 0644 "$candidate" "$CADDY_CONFIG"
	if ! "$CADDY_BINARY" validate --config "$CADDY_CONFIG" --adapter caddyfile >/dev/null 2>&1; then
		install -m 0644 "$backup" "$CADDY_CONFIG"
		fail "caddy rejected the generated Caddyfile; restored ${backup}"
	fi
	CADDY_CHANGED=1
	log "added caddy site: ${DOMAIN} -> 127.0.0.1:${PORT}"
}

reload_services() {
	systemctl --user daemon-reload

	if ((UNIT_CHANGED == 1)); then
		systemctl --user enable --now ttyd.service
		systemctl --user restart ttyd.service
		log "restarted ttyd"
	elif ! systemctl --user is-active --quiet ttyd.service; then
		systemctl --user enable --now ttyd.service
		log "started ttyd"
	fi

	if ((AUTHELIA_CHANGED == 1)); then
		systemctl --user restart authelia.service
		wait_for_authelia
		log "restarted authelia"
	fi

	if ((CADDY_CHANGED == 1)); then
		systemctl --user reload caddy.service ||
			systemctl --user restart caddy.service
		log "reloaded caddy"
	fi
}

wait_for_authelia() {
	local remaining=20
	while ((remaining > 0)); do
		# Authelia closes the port briefly while restarting; only the timeout is an error.
		curl -fsS -o /dev/null --max-time 2 2>/dev/null \
			"http://127.0.0.1:${AUTHELIA_PORT}/api/health" && return 0
		remaining=$((remaining - 1))
		sleep 1
	done
	fail "authelia did not become healthy on 127.0.0.1:${AUTHELIA_PORT} within 20s"
}

verify_local_terminal() {
	local status
	status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
		"http://127.0.0.1:${PORT}/" || true)"
	[[ $status == 200 ]] ||
		fail "ttyd is not answering on 127.0.0.1:${PORT} (status: ${status:-none})"
	log "ttyd answers on 127.0.0.1:${PORT}"
}

verify_authelia_rule() {
	local result
	result="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 5 \
		-H "X-Forwarded-Host: ${DOMAIN}" \
		-H 'X-Forwarded-Proto: https' \
		-H 'X-Forwarded-Uri: /' \
		-H 'X-Forwarded-Method: GET' \
		"http://127.0.0.1:${AUTHELIA_PORT}/api/authz/forward-auth" || true)"
	[[ $result == 302* ]] ||
		fail "authelia does not gate ${DOMAIN} (got: ${result:-no response})"
	log "authelia gates ${DOMAIN}"
}

verify_caddy_route() {
	local live
	live="$(curl -s --max-time 5 "${CADDY_ADMIN}/config/" || true)"
	[[ $live == *"${DOMAIN}"* ]] ||
		fail "caddy is not serving ${DOMAIN}; check: systemctl --user reload caddy"
	log "caddy serves ${DOMAIN}"
}

verify_frontend() {
	[[ -f "${APP_ROOT}/index.html" ]] || fail "frontend not deployed at ${APP_ROOT}"
	[[ -f "${APP_ROOT}/manifest.webmanifest" ]] || fail "frontend manifest missing at ${APP_ROOT}"
	log "frontend deployed at ${APP_ROOT}"
}

verify() {
	verify_local_terminal
	wait_for_authelia
	verify_authelia_rule
	verify_caddy_route
	verify_frontend
}

print_next_steps() {
	local address=""
	if command -v dig >/dev/null 2>&1; then
		address="$(dig +short "$PORTAL_DOMAIN" 2>/dev/null | head -1)"
	fi

	printf '\n'
	log "terminal: https://${DOMAIN}"
	log "portal:   https://${PORTAL_DOMAIN}"

	if ! command -v dig >/dev/null 2>&1 || [[ -z $(dig +short "$DOMAIN" 2>/dev/null) ]]; then
		log "DNS record missing. Add:"
		log "  ${DOMAIN}  A  ${address:-<public address of ${PORTAL_DOMAIN}>}"
		log "Caddy retries certificate issuance once the record resolves."
	else
		log "DNS resolves; reload caddy if the certificate is not issued yet."
	fi
}

main() {
	parse_arguments "$@"
	require_commands
	require_settings
	install_ttyd
	install_unit
	install_app
	patch_authelia
	patch_caddy
	reload_services
	verify
	print_next_steps
}

main "$@"
