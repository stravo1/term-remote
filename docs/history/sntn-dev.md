# Reference deployment record

The repository README is generic. This file records the specific deployment that motivated it, for
anyone maintaining that host. It is not needed to install the project elsewhere.

## Host

Ubuntu 24.04, user `stravo1`, host `sntn`. Caddy, Authelia, pi remote and SearXNG already ran as
user services with `loginctl enable-linger` set, and the live configurations were:

- `~/.config/pi-remote/Caddyfile`
- `~/.config/authelia/configuration.yml`

## Live URLs

- terminal: <https://term.sntn.dev>
- portal: <https://auth.sntn.dev>

`term.sntn.dev` resolves to the same address as `auth.sntn.dev`. Let's Encrypt issued
`CN=term.sntn.dev` on 2026-10-31 20:17 UTC.

## Checkouts

| Path                      | Role                                              |
| ------------------------- | ------------------------------------------------- |
| `~/projects/term-remote` | development clone, where changes are made          |
| `~/term-remote`          | deploy target, rsynced by CI on every push         |

Never edit `~/term-remote` by hand. The next deploy overwrites it.

## DNS

```
term.sntn.dev    A    <address of auth.sntn.dev>
```

## Checks on the host

```sh
systemctl --user status ttyd caddy authelia
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7681/                 # 200
curl -s -o /dev/null -w '%{redirect_url}\n' \
  --resolve term.sntn.dev:443:127.0.0.1 https://term.sntn.dev/                   # → portal
journalctl --user -u caddy -n 50 | grep term.sntn.dev                           # cert
```

Every path, including `/app.js`, redirects to the portal until a session exists. After login the page
shows an online dot and a shell. DevTools → Application → Manifest confirms installability.

## Changelog

**2026-10-31 — initial setup on `sntn`.**

1. Installed ttyd 1.7.7 static binary to `~/.local/bin/ttyd`.
2. Added `~/.config/systemd/user/ttyd.service`, loopback `:7681`, writable, 4 clients,
   `tmux new -A -s main`.
3. Added `term.sntn.dev` / `two_factor` to `access_control.rules`.
4. Added the `term.sntn.dev` site block to `~/.config/pi-remote/Caddyfile` (`forward_auth` plus
   `Remote-User` scrubbing, mirroring `pi.sntn.dev`).
5. Reloaded Caddy, restarted Authelia, confirmed `pi.sntn.dev` was unaffected, and confirmed
   Let's Encrypt issued the certificate.
6. Replaced ttyd's bundled client with the `app/` PWA frontend. Caddy now proxies only `/token` and
   `/ws` to ttyd and serves the rest from `~/.local/share/term-remote/app`. Assets, MIME types, 404s
   and a `101 Switching Protocols` upgrade were verified against a scratch Caddy instance.
7. Moved everything into this repository and deployed it from GitHub Actions through a
   forced-command deploy key. `deploy/deploy-key.sh` only replaces the entry for its own checkout, so
   the pi remote deploy key keeps working.

**2026-11-01 — renamed to term-remote, made the defaults generic.**

1. Renamed the repository, the script, the marker blocks, the frontend cache and the
   install directory from `web-terminal` to `term-remote`.
2. Moved the host's real hostnames and Caddy path out of the script into the untracked
   `~/.config/term-remote/env`. The script now defaults to placeholders and refuses to
   run against them.
3. The provisioner still strips the old `web-terminal` marker blocks, so the live
   Caddyfile and Authelia configuration migrated on the first deploy instead of ending
   up with two site blocks.

## Known drift

Before this terminal existed, the pi remote Caddyfile copies under `~/pi-remote/deploy/` and
`~/projects/pi-remote/deploy/` already differed from the live file under `~/.config`. The live file is
authoritative, and the provisioner only touches that one. Reconciling the pi remote copies is
unrelated work.
