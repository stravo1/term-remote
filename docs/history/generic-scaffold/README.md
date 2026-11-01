# Web terminal: Caddy + Authelia + ttyd (generic scaffold) — NOT DEPLOYED

> Reference only. This is the container/root variant written before the live
> `term.sntn.dev` setup. What actually runs on this VM is documented in
> [`../../README.md`](../../README.md) and provisioned by
> [`../../setup-term-remote.sh`](../../setup-term-remote.sh).

Browser terminal for a VM, gated by Authelia SSO through Caddy forward-auth.

```
browser --TLS--> Caddy --forward_auth--> Authelia
                    \--WebSocket--> 127.0.0.1:7681 (ttyd)
```

ttyd listens on loopback only and has no credentials of its own. Authelia is
the only gate.

## Install

1. **ttyd**

   ```bash
   sudo apt install -y ttyd tmux
   sudo useradd --create-home --shell /bin/bash terminal
   sudo cp ttyd.service /etc/systemd/system/ttyd.service
   sudo systemctl enable --now ttyd
   ```

2. **Authelia**

   ```bash
   for i in 1 2 3; do openssl rand -hex 32; done   # jwt, session, storage
   # paste the three values into authelia/configuration.yml
   docker compose up -d
   ```

   Hash the login password with the command in `authelia/users.yml`, then
   replace `CHANGE_ME_ARGON2ID_HASH`.

3. **Caddy**

   ```bash
   sudo apt install -y caddy
   sudo cp Caddyfile /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

4. Replace `example.com` in `Caddyfile`, `configuration.yml` and
   `users.yml` with your domain. Caddy issues the certificates itself.

## Verify

```bash
curl -sI https://term.example.com | head -3   # expect 302 to auth.example.com
```

Then open `https://term.example.com`, log in at the portal, and you should
land in the terminal. Every browser tab attaches to the same tmux session, so
dropped connections and phone screen locks do not kill the shell.

## Notes

- **One OS user for everyone.** Authelia decides who may enter; every visitor
  lands as `terminal`. Per-user shells need a different tool (sshwifty,
  Guacamole).
- **Session expiry does not close open terminals.** forward-auth runs once, at
  the WebSocket handshake. Shorten `session.inactivity` or restart ttyd on
  logout if that matters.
- **Caddy inside Docker?** `127.0.0.1` in the Caddyfile then points at the
  container, not the host. Run Caddy with `network_mode: host` or publish
  both upstreams on the bridge.
- **403 on the handshake** means `Host`/`Origin` disagree; Caddy preserves
  both by default, so check for another proxy in the chain.
