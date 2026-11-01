# Web terminal (`term.sntn.dev`)

A browser terminal for this VM: **ttyd** behind **Caddy** forward-auth and
**Authelia** TOTP. Reachable from any device with a browser, no SSH client or
VPN needed. Pushing to `main` on GitHub deploys it.

```
browser ──TLS──> Caddy ──forward_auth──> Authelia (127.0.0.1:9091)
                    └──reverse_proxy───> ttyd (127.0.0.1:7681) ──> tmux "main"
```

ttyd binds loopback only and has no credentials of its own. Authelia is the
only gate, so the terminal host is unreachable unless the proxy forwards it.
The page itself is a custom mobile-first PWA in `app/`; ttyd is used purely as
a pty backend, with only `/token` and `/ws` proxied to it.

- terminal: <https://term.sntn.dev>
- portal: <https://auth.sntn.dev>

## CI/CD and re-provisioning

A push to `main` runs the tests, then CI tars the release and pipes it to a
forced command on this host, which runs the provisioner. See
[docs/deployment.md](docs/deployment.md) for the secrets, the one-time deploy
key bootstrap, and rollback.

Locally, the provisioner is also the manual deploy:

```bash
./setup-web-terminal.sh          # idempotent: re-running changes nothing
./setup-web-terminal.sh --force  # also overwrite a hand-edited ttyd unit
```

The script installs ttyd, writes the user unit, patches the Authelia rule and
the Caddy site block, deploys the frontend, restarts what changed, then
verifies. Everything it owns is wrapped in `# >>> web-terminal …` / `# <<<
web-terminal` markers, so it replaces only its own blocks.

It refuses to guess: if either config already contains an unmanaged rule or
site block for the domain, it stops and tells you to remove that first.

Overridable via environment, defaults shown:

| Variable                           | Default                                |
| ---------------------------------- | -------------------------------------- |
| `WEB_TERMINAL_DOMAIN`              | `term.sntn.dev`                        |
| `AUTHELIA_PORTAL_DOMAIN`           | `auth.sntn.dev`                        |
| `AUTHELIA_POLICY`                  | `two_factor`                           |
| `WEB_TERMINAL_PORT`                | `7681`                                 |
| `WEB_TERMINAL_MAX_CLIENTS`         | `4`                                    |
| `WEB_TERMINAL_TMUX_SESSION`        | `main`                                 |
| `TTYD_VERSION`                     | `ttyd.version` (currently `1.7.7`)     |
| `CADDY_CONFIG`                     | `~/.config/pi-remote/Caddyfile`        |
| `AUTHELIA_CONFIG`                  | `~/.config/authelia/configuration.yml` |
| `AUTHELIA_PORT`                    | `9091`                                 |
| `CADDY_ADMIN`                      | `http://127.0.0.1:2019`                |
| `CADDY_BINARY` / `AUTHELIA_BINARY` | resolved from `PATH`                   |

Layout:

```
setup-web-terminal.sh          provisioner (installs, patches, verifies)
ttyd.version                   the one pinned ttyd release
app/                           PWA frontend (HTML, CSS, JS, icons, vendor)
templates/                     the three files the provisioner renders
deploy/receive.sh              forced command that CI runs on this host
deploy/deploy-key.sh           installs a CI deploy key in authorized_keys
tests/                         node:test suite, including the ttyd protocol
tools/check-repository.mjs     syntax and executable-bit checks
tools/generate-icons.py        regenerates app/icons/*.png without a GUI lib
docs/deployment.md             CI, secrets, bootstrap, rollback
docs/history/generic-scaffold  the early container variant, NOT deployed
```

Checks before a commit:

```bash
npm run check   # prettier, shellcheck, shell/JS/Python syntax, JSON
npm test        # repository invariants + live ttyd protocol test
```

## What is installed on this machine

| Path                                   | Managed by                             |
| -------------------------------------- | -------------------------------------- |
| `~/.local/bin/ttyd`                    | script (static v1.7.7, no root needed) |
| `~/.config/systemd/user/ttyd.service`  | script (user unit, enabled)            |
| `~/.config/pi-remote/Caddyfile`        | script owns one marker block           |
| `~/.config/authelia/configuration.yml` | script owns one marker block           |
| `~/.local/share/web-terminal/app`      | script (copy of `app/`)                |

Backups are written next to a file as `<name>.bak.<epoch>` before the script
changes it. They pile up across runs; prune them freely.

Services are **user** units to match the rest of `pi-remote` (authelia, caddy,
pi-remote, searxng). `loginctl enable-linger stravo1` is already set, so they
survive logout.

## Mobile / PWA

ttyd's own client is desktop-shaped: no Escape, Tab, Ctrl or arrow keys, no
home-screen install, no safe-area or soft-keyboard handling. So the site serves
its own frontend (`app/`) that speaks ttyd's WebSocket protocol directly, and
Caddy proxies only `/token` and `/ws` to ttyd.

The protocol is small and was verified against the running ttyd 1.7.7: binary
frames, `0` + input, `1` + JSON resize, a JSON init frame with `AuthToken`,
`columns`, `rows`, and `0` / `1` / `2` for output, window title and preferences
from the server.

What the frontend gives you:

- **Key bar** above the keyboard: Esc, Tab, sticky Ctrl/Alt, arrows, Home, End,
  PgUp, PgDn, `|`, `-`, `/`, `~`. Sticky modifiers also apply to the next
  character typed on the soft keyboard, so Ctrl-C and Esc work in vim or tmux.
- **Installable**: Android/Chrome → ⋮ _Add to Home screen_; iOS/Safari → Share
  → _Add to Home Screen_. Runs standalone, no browser chrome.
- **Keyboard-aware**: `dvh` plus `visualViewport` tracking keeps the key bar
  above the soft keyboard, with notch-safe insets.
- **Font size** A−/A+, persisted in `localStorage`.
- **Touch scrolling** through scrollback, reconnect with backoff on drops, and
  a Reconnect button.
- **Offline shell**: the service worker caches the app, so the installed icon
  still opens when the VM is unreachable, then reports "Connection lost".

Editing the frontend: change `app/`, bump `CACHE_NAME` in `app/sw.js` (the
service worker caches shell files), then re-run `./setup-web-terminal.sh` to
copy it to `~/.local/share/web-terminal/app`. `xterm.js` and `addon-fit.js` are
vendored in `app/vendor/` at 5.5.0 / 0.10.0 — no CDN at runtime.

## Manual checks

```bash
systemctl --user status ttyd caddy authelia
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7681/            # 200
curl -s -o /dev/null -w '%{redirect_url}\n' \
  --resolve term.sntn.dev:443:127.0.0.1 https://term.sntn.dev/              # → portal
journalctl --user -u caddy -n 50 | grep term.sntn.dev                      # cert
```

Unchanged behaviour to expect: every path, including `/app.js`, redirects to
the portal until you have a session — static assets are gated too. After login
the page should report an online dot and show the shell. DevTools →
Application → Manifest confirms installability.

The first request redirects to `auth.sntn.dev`; log in with TOTP and you land
in a shell as `stravo1`.

### Adding the DNS record on a fresh machine

Caddy cannot issue a certificate until the name resolves:

```
term.sntn.dev    A    <address of auth.sntn.dev>
```

Caddy retries on its own every minute, or force it:

```bash
systemctl --user reload caddy
```

## Operational notes

- **Full shell as `stravo1`.** Not a sandbox: `~/.ssh`, `~/.pi`, the whole home
  directory is readable from the browser tab.
- **Session expiry does not close a terminal.** forward-auth runs once, at the
  WebSocket handshake. Authelia's `inactivity: 5 minutes` governs new
  connections, not the ones already open.
- **One shared tmux session.** Every tab and device attaches to `main`, so a
  phone and a laptop see the same screen. Use `--max-clients` to cap it.
- **Certificates renew automatically.** Nothing to do.
- **Deploy copies drift.** `~/pi-remote/deploy/Caddyfile` and
  `~/projects/pi-remote/deploy/Caddyfile` differed from the live file before
  this terminal existed. The live file under `~/.config` is authoritative; the
  script only touches that one.

## Changelog

2026-10-31 — initial setup on `sntn` (Ubuntu 24.04, user `stravo1`).

1. Installed ttyd 1.7.7 static binary to `~/.local/bin/ttyd`.
2. Added `~/.config/systemd/user/ttyd.service` — loopback `:7681`, writable,
   4 clients, `tmux new -A -s main`.
3. Added `term.sntn.dev` / `two_factor` to `access_control.rules`.
4. Added the `term.sntn.dev` site block to `~/.config/pi-remote/Caddyfile`
   (`forward_auth` + `Remote-User` scrubbing, mirroring `pi.sntn.dev`).
5. Reloaded Caddy, restarted Authelia, confirmed `pi.sntn.dev` unaffected and
   Let's Encrypt issued `CN=term.sntn.dev` on 2026-10-31 20:17 UTC.
6. Replaced ttyd's bundled client with the `app/` PWA frontend; Caddy now
   proxies only `/token` and `/ws` to ttyd and serves the rest from
   `~/.local/share/web-terminal/app`. Verified assets, MIME types, 404s and a
   `101 Switching Protocols` upgrade against a scratch Caddy instance.
