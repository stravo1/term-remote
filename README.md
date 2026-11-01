# term-remote

A browser terminal for one Linux host. **ttyd** provides the pty, a small mobile-first **PWA**
provides the UI, **Caddy** gates everything with forward-auth, and **Authelia** authenticates with
TOTP. One idempotent script provisions the host, and GitHub Actions deploys it on push.

```
browser ──TLS──> Caddy ──forward_auth──> Authelia
                    ├──/token, /ws─────> ttyd ──> tmux
                    └──static files────> app/ (PWA)
```

## How it works

- ttyd binds to `127.0.0.1` and has no credentials of its own. Authelia is the only gate, so the
  pty is unreachable unless the proxy forwards to it.
- The frontend in `app/` speaks ttyd's WebSocket protocol directly, so ttyd is reduced to a pty
  backend: Caddy proxies only `/token` and `/ws` to it and serves the rest as static files.
- `setup-term-remote.sh` is the only thing that changes the host. It owns exactly one
  marker-delimited block in the Caddyfile and one in the Authelia configuration, and nothing else.

## Requirements

- Linux with systemd and a working user session. Enable lingering if the services should survive
  logout: `loginctl enable-linger "$USER"`.
- Caddy and Authelia already running as **user** services. Authelia needs the file backend and its
  forward-auth endpoint. The provisioner assumes Caddy's site config and Authelia's configuration
  live under `~/.config`; override the paths with `CADDY_CONFIG` and `AUTHELIA_CONFIG`.
- `tmux`, `curl`, `rsync`, `sed`, `awk`. Root is not needed: ttyd is a static binary installed into
  `~/.local/bin`.
- A DNS record for the terminal host, and ports 80/443 reachable, so Caddy can solve an ACME
  challenge.

## Quick start

```sh
git clone <this repository> ~/term-remote
cd ~/term-remote

mkdir -p ~/.config/term-remote
cp env.example ~/.config/term-remote/env
$EDITOR ~/.config/term-remote/env        # real hostnames, and the Caddy path

./setup-term-remote.sh
```

The script then:

1. Installs the pinned ttyd release into `~/.local/bin` if it is missing.
2. Renders and enables a user unit that runs `ttyd … tmux new -A -s main` on loopback.
3. Copies `app/` to `~/.local/share/term-remote/app`.
4. Adds one Authelia access-control rule and one Caddy site block inside its own markers.
5. Restarts only the services whose files changed, then verifies that ttyd answers, that Authelia
   gates the domain, that Caddy serves it, and that the frontend is deployed.

It is safe to re-run: a second run reports `unchanged` for everything. If Authelia or Caddy rejects
the generated configuration, the script restores the backup it took and exits non-zero instead of
restarting a broken service.

It refuses to guess. If either config already contains an unmanaged rule or site block for the
domain, it stops and tells you to remove that first, rather than creating a duplicate.

`--force` overwrites a `ttyd.service` unit that the script does not consider its own. Other flags are
documented in `./setup-term-remote.sh --help`.

After the first run, create the DNS record if you have not already. Caddy retries certificates on its
own, or force it with `systemctl --user reload caddy`.

## Configuration

Settings live in `~/.config/term-remote/env`, one `KEY=VALUE` per line with no quotes. Copy
`env.example` to get started. The file is not in git, so a checkout carries no hostnames.

```sh
TERM_REMOTE_DOMAIN=term.example.com
AUTHELIA_PORTAL_DOMAIN=auth.example.com
AUTHELIA_POLICY=two_factor
CADDY_CONFIG=/home/you/.config/caddy/Caddyfile
```

The shell environment wins over the file, and the file wins over the built-in defaults. The defaults
are placeholders (`term.example.com`, `auth.example.com`) and the script **refuses to run** while a
hostname is still a placeholder, so a half-configured host cannot quietly rewrite its proxy config.

Every value below can be set in the environment. The defaults are defined at the top of
`setup-term-remote.sh`; `TTYD_VERSION` defaults to the contents of `ttyd.version`.

| Variable                   | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `TERM_REMOTE_DOMAIN`       | public hostname of the terminal                                       |
| `AUTHELIA_PORTAL_DOMAIN`   | hostname of the Authelia portal, used by the cert-failure message     |
| `AUTHELIA_POLICY`          | access-control policy for the terminal site, for example `two_factor` |
| `TERM_REMOTE_PORT`         | loopback port for ttyd                                                |
| `TERM_REMOTE_MAX_CLIENTS`  | concurrent browser clients ttyd accepts                               |
| `TERM_REMOTE_TMUX_SESSION` | tmux session every client attaches to                                 |
| `TTYD_VERSION`             | override the pinned ttyd release                                      |
| `CADDY_CONFIG`             | path to the Caddyfile                                                 |
| `AUTHELIA_CONFIG`          | path to the Authelia configuration                                    |
| `AUTHELIA_PORT`            | Authelia listen port, used for forward-auth and health checks         |
| `CADDY_ADMIN`              | Caddy admin API, used to confirm the site is live                     |
| `APP_ROOT`                 | where the frontend is installed                                       |
| `CADDY_BINARY`             | caddy executable, otherwise resolved from `PATH`                      |
| `AUTHELIA_BINARY`          | authelia executable, otherwise resolved from `PATH`                   |

## What the provisioner owns

| Path                                  | What it does                              |
| ------------------------------------- | ----------------------------------------- |
| `~/.local/bin/ttyd`                   | static ttyd binary, no root needed        |
| `~/.config/systemd/user/ttyd.service` | user unit, enabled and started            |
| `$CADDY_CONFIG`                       | one marker block, the terminal site       |
| `$AUTHELIA_CONFIG`                    | one marker block, the access-control rule |
| `$APP_ROOT`                           | copy of `app/`, served by Caddy           |

Before changing a file the script copies it to `<name>.bak.<epoch>`. Backups pile up across runs, so
prune them now and then. Everything is a **user** unit, so it matches a Caddy and Authelia that run
the same way.

## Frontend

ttyd's own client is desktop-shaped: no Escape, Tab, Ctrl or arrow keys, no home-screen install, no
safe-area or soft-keyboard handling. `app/` replaces it with:

- **One bottom bar holds everything**: font size, scheme toggle, and the keys — Esc, Tab, sticky
  Ctrl/Alt, arrows, Home, End, PgUp, PgDn, `|`, `-`, `/`, `~`. Sticky modifiers also apply to the
  next character typed on the soft keyboard, so Ctrl-C and Esc work in vim or tmux. There is no
  header; the terminal owns the whole screen.
- **Espresso design system**: colors, radii, and focus rings come from frappe-ui's design tokens
  (`app/vendor/espresso.css`, generated — see below), with JetBrains Mono for everything. Light and dark schemes both work, with a ◐ toggle; the terminal, the installed
  app's status bar, and the page all follow the scheme.
- **Installable**: Android/Chrome → ⋮ _Add to Home screen_; iOS/Safari → Share → _Add to Home
  Screen_. Runs standalone, with no browser chrome.
- **Keyboard-aware layout**: `dvh` plus `visualViewport` tracking keeps the key bar above the soft
  keyboard, with notch-safe insets.
- **Font size** A−/A+ and the scheme toggle ◐ live in the bottom bar; the choice persists in `localStorage`.
- **Touch scrolling** through scrollback, reconnect with backoff, and a Reconnect button.
- **No service worker, on purpose.** A cached page paired with a fresh script is a terminal that
  never connects, so the shell is served with `Cache-Control: no-cache` and revalidated on every
  load. Installability comes from the manifest alone.

The protocol is small: binary frames, `0` + input, `1` + JSON resize, a JSON init frame with
`AuthToken`, `columns` and `rows`, and `0` / `1` / `2` for output, window title and preferences from
the server. `tests/protocol.test.mjs` starts a real ttyd and asserts each of those, so a ttyd upgrade
that changes framing fails CI before it reaches the page.

To change the frontend, edit `app/` and re-run the provisioner. `xterm.js`, `addon-fit.js`, the Espresso tokens, and the Inter
and JetBrains Mono fonts are vendored in `app/vendor/`; the page makes no external requests at
runtime. After a frappe-ui upgrade, refresh the tokens with
`node tools/generate-espresso.mjs <path-to-frappe-ui>`.

## CI/CD

A push to `main` runs the tests, then the deploy job tars the release and pipes it to a restricted
SSH key on the host. The key's forced command runs `deploy/receive.sh`, which rsyncs the checkout and
runs the provisioner. A failed verification fails the deploy, so a broken change never lands quietly.

Secrets live on the `production` environment: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `DEPLOY_USER`,
`DEPLOY_HOST`. See [docs/deployment.md](docs/deployment.md) for the one-time key bootstrap, the manual
deploy path, and rollback.

`ttyd.version` is the single owner of the pinned release: CI reads it to install the binary for the
protocol test, and the provisioner reads it on the host.

## Layout

```
app/                           PWA frontend (HTML, CSS, JS, icons, vendor)
templates/                     the three files the provisioner renders
setup-term-remote.sh          provisioner: installs, patches, restarts, verifies
ttyd.version                   the pinned ttyd release
env.example                    template for ~/.config/term-remote/env
deploy/receive.sh              forced command CI runs on the host
deploy/deploy-key.sh           installs a CI deploy key in authorized_keys
tests/                         node:test suite, including the ttyd protocol
tools/check-repository.mjs     syntax and executable-bit checks
tools/generate-icons.py        regenerates app/icons/*.png without a GUI library
tools/generate-espresso.mjs    regenerates the vendored Espresso tokens and fonts
docs/deployment.md             CI, secrets, bootstrap, rollback
docs/history/                  reference deployment record and the early container variant
```

## Checks

```sh
npm run check   # prettier, shellcheck, shell/JS/Python syntax, JSON, executable bits
npm test        # repository invariants plus the live ttyd protocol test
```

`npm test` needs ttyd. Set `TTYD_BIN` if it is not in `~/.local/bin`; the protocol test skips itself
when ttyd is missing.

## Security notes

- **This is a full shell as the service user**, not a sandbox. Anyone who gets past Authelia can read
  that user's home directory, including SSH keys.
- **Forward-auth runs once, at the WebSocket handshake.** Expiring an Authelia session does not close
  a terminal that is already open. Keep the session lifetime short if that matters.
- **One OS user for every visitor.** Authelia decides who may enter; every visitor lands as the same
  account. Per-user shells need a different tool.
- **Keep ttyd on loopback.** Exposing `TERM_REMOTE_PORT` directly bypasses Authelia entirely.
- **`two_factor` needs a registered second factor.** Enrolling before raising the policy avoids a
  login dead end.
