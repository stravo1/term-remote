# Deployment

The host runs a checkout at `~/web-terminal` and CI deploys into it. There is no
build step: the frontend is plain files and `setup-web-terminal.sh` is the deploy
script. A push to `main` changes the live site once the tests pass.

## Flow

1. A push to `main` runs the `test` job: `npm ci`, `npm run check`, `npm test`.
   The tests include a live ttyd protocol test, downloaded at the pinned version.
2. The `deploy` job runs only for `main`, inside the `production` environment. It
   tars the release and pipes it to SSH.
3. The SSH key is restricted with `restrict,command=.../deploy/receive.sh`, so it
   cannot open a shell. Its only capability is deploying this repository.
4. `receive.sh` stages the tar, rsyncs it into the checkout, and runs the
   provisioner.
5. The provisioner rewrites only its own marker blocks, restarts only the services
   that changed, and verifies ttyd, Authelia, Caddy and the frontend. A failed
   verification fails the deploy, so CI goes red instead of the site breaking
   quietly.
6. `receive.sh` replaces itself last, by rename, so the next push runs the newer
   version.

## Secrets

They live on the `production` environment, not at repository level:

| Secret               | Value                                |
| -------------------- | ------------------------------------ |
| `DEPLOY_SSH_KEY`     | private key of the CI deploy keypair |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan` output for the host    |
| `DEPLOY_USER`        | `stravo1`                            |
| `DEPLOY_HOST`        | address of the VM                    |

## One-time host bootstrap

```sh
gh repo clone stravo1/web-terminal ~/web-terminal
ssh-keygen -t ed25519 -N "" -C web-terminal-ci -f /tmp/web-terminal-ci
bash ~/web-terminal/deploy/deploy-key.sh /tmp/web-terminal-ci.pub

gh secret set DEPLOY_SSH_KEY --env production < /tmp/web-terminal-ci
ssh-keyscan -p 22 <host> | gh secret set DEPLOY_KNOWN_HOSTS --env production
printf '%s' stravo1 | gh secret set DEPLOY_USER --env production
printf '%s' <host> | gh secret set DEPLOY_HOST --env production

shred -u /tmp/web-terminal-ci && rm -f /tmp/web-terminal-ci.pub
```

`deploy-key.sh` removes only entries for its own checkout, so the pi remote
deploy key keeps working. To revoke CI deploys, delete the line containing
`command="…/web-terminal/deploy/receive.sh"` from `~/.ssh/authorized_keys`.

## Manual deploy

From the checkout on the host:

```sh
cd ~/web-terminal && ./setup-web-terminal.sh
```

To exercise the exact CI path without GitHub:

```sh
cd ~/web-terminal
tar -c app templates tools deploy setup-web-terminal.sh ttyd.version README.md LICENSE \
  | ./deploy/receive.sh
```

## Rollback

Revert the commit and push. CI redeploys the reverted tree. Editing the checkout
by hand does not survive, because every deploy rsyncs over it.

## Changing the domain, port or ttyd version

- Domain and port are defaults in `setup-web-terminal.sh`; override them with
  environment variables or change the defaults.
- A new domain needs its DNS record. The provisioner adds the Authelia rule and
  the Caddy block itself.
- The ttyd version lives in `ttyd.version`. Bump it there; CI installs the same
  version for the protocol test, and the provisioner installs it on the host.

## Troubleshooting

- **Deploy step hangs.** The forced command is failing. Run the manual CI path
  above on the host to see the error.
- **CI red at deploy.** The provisioner prints which verification failed: ttyd
  not answering, Authelia not gating the domain, or Caddy not serving it.
- **A change did not restart anything.** That is expected when the rendered files
  did not change. `systemctl --user restart ttyd` forces it.
- **The browser shows an old page.** The service worker cached it. Bump
  `CACHE_NAME` in `app/sw.js` and push.
