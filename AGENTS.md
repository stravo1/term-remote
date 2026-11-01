# Web terminal

A browser terminal for a single VM: ttyd on loopback, a mobile-first PWA frontend, Caddy
forward-auth, and Authelia TOTP. It runs on the same host as pi remote.

## Layout

- `app/` is the PWA frontend. It speaks ttyd's WebSocket protocol itself, so ttyd is only a pty backend.
- `templates/` holds the three files the provisioner renders.
- `setup-term-remote.sh` is the only thing that changes the host. It is idempotent.
- `deploy/` holds the CI receiver and the deploy-key helper.
- `docs/deployment.md` describes CI, secrets, and the host bootstrap.

## Rules

- Never edit the live files by hand. The provisioner owns one marker block in the Caddyfile and
  one in the Authelia configuration; anything else drifts.
- Change the host through a template or the provisioner, then run it on the host.
- Run `npm run check` and `npm test` before a commit.
- `app/vendor/` is committed on purpose: the page must work with no CDN.
- Bump `CACHE_NAME` in `app/sw.js` whenever shell files change, or installed clients keep the old page.
- Write docs in plain English: short sentences, active voice, no em dashes.
- Use Conventional Commits: `<type>[optional scope]: <short imperative summary>`.
- Ask the user before you commit or push.
