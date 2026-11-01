#!/usr/bin/env bash
# Install a deploy public key in authorized_keys so GitHub Actions can deploy.
# Run it on the host, from the checkout that CI deploys into:
#
#   bash deploy/deploy-key.sh deploy_key.pub
#
# The key gets a forced command that runs this checkout's deploy/receive.sh, so
# the key can only deploy, never open a shell. Running it again replaces the
# key for this checkout and leaves other checkouts' keys alone.
set -euo pipefail

directory="$(cd "$(dirname "$0")/.." && pwd)"
key_command="$directory/deploy/receive.sh"
pubkey_file="${1:-}"

if [ -z "$pubkey_file" ] || [ ! -f "$pubkey_file" ]; then
  echo "Usage: bash deploy/deploy-key.sh <deploy_key.pub>" >&2
  exit 1
fi

pubkey="$(head -n 1 "$pubkey_file")"
case "$pubkey" in
  ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*\ *) ;;
  *)
    echo "Error: $pubkey_file does not look like a public key." >&2
    exit 1
    ;;
esac

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$HOME/.ssh/authorized_keys" ]; then
  install -m 600 /dev/null "$HOME/.ssh/authorized_keys"
fi

# Drop only this checkout's older entry. Other forced commands, such as the
# pi remote deploy key, must survive.
grep -vF "command=\"$key_command\"" "$HOME/.ssh/authorized_keys" >"$HOME/.ssh/authorized_keys.next" || true
install -m 600 "$HOME/.ssh/authorized_keys.next" "$HOME/.ssh/authorized_keys"
rm -f "$HOME/.ssh/authorized_keys.next"

printf 'restrict,command="%s" %s term-remote-ci\n' "$key_command" "$pubkey" \
  >>"$HOME/.ssh/authorized_keys"

echo "Deploy key installed. CI deploys now install into $directory."
