#!/usr/bin/env bash
# Forced command for the CI deploy key. It reads a tar of the release on stdin,
# installs it into this checkout, and runs the provisioner, which is idempotent:
# it rewrites only what changed, restarts only the services that changed, and
# verifies the result. A failed verification fails the deploy.
#
# It replaces itself from the release it just received, so the next push runs
# the newer version.
set -euo pipefail

# sshd gives a forced command a minimal environment. easy-install links node and
# friends in ~/.local/bin, and systemctl --user needs the session bus.
PATH="$HOME/.local/bin:$PATH"
export PATH
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  runtime_directory="/run/user/$(id -u)"
  export XDG_RUNTIME_DIR="$runtime_directory"
fi

directory="$(cd "$(dirname "$0")/.." && pwd)"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

tar -x --no-same-owner -C "$staging"
if [ ! -f "$staging/app/index.html" ] || [ ! -f "$staging/setup-web-terminal.sh" ]; then
  echo "Incomplete release: app/index.html and setup-web-terminal.sh are required." >&2
  exit 1
fi

rsync -a --delete "$staging/app/" "$directory/app/"
rsync -a --delete "$staging/templates/" "$directory/templates/"
rsync -a --delete "$staging/tools/" "$directory/tools/"
install -m 755 "$staging/setup-web-terminal.sh" "$directory/setup-web-terminal.sh"
cp "$staging/ttyd.version" "$directory/ttyd.version"
cp "$staging/README.md" "$staging/LICENSE" "$directory/"

if [ -d "$staging/deploy" ]; then
  # receive.sh stays out of the copy and the delete until the self-replace below:
  # overwriting the file a running bash reads from can corrupt the unread tail.
  mkdir -p "$directory/deploy"
  rsync -a --delete --exclude=receive.sh "$staging/deploy/" "$directory/deploy/"
fi

cd "$directory"
./setup-web-terminal.sh

if [ -f "$staging/deploy/receive.sh" ] && ! cmp -s "$staging/deploy/receive.sh" "$directory/deploy/receive.sh"; then
  install -m 755 "$staging/deploy/receive.sh" "$directory/deploy/receive.sh.new"
  mv -f "$directory/deploy/receive.sh.new" "$directory/deploy/receive.sh"
  echo "receive.sh updated; it runs on the next push."
fi

echo "Deployed."
