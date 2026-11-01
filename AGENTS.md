# term-remote

A browser terminal for a single host: ttyd on loopback, a mobile-first PWA frontend in the Espresso
design system, Caddy forward-auth, and Authelia TOTP.

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
- `app/vendor/` is committed on purpose: the page must work with no build step and no CDN.
- Style the UI with the Espresso design tokens from `app/vendor/espresso.css` only. No hardcoded
  colors anywhere; the page supports light and dark through `[data-theme]`.
- Regenerate `app/vendor/espresso.css` and the fonts with `node tools/generate-espresso.mjs` after a
  frappe-ui upgrade; do not edit the generated files.
- There is no service worker, on purpose: a cached page paired with a fresh script is a terminal
  that never connects. Every element id `app.js` reads must exist in `app/index.html`.
- Write docs in plain English: short sentences, active voice, no em dashes.
- Use Conventional Commits: `<type>[optional scope]: <short imperative summary>`.
- Ask the user before you commit or push.
