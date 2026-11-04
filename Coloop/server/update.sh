#!/bin/bash
# Updates only application code. Preserves channels, credentials, TLS and SSH settings.
set -euo pipefail
cd -- "$(dirname -- "$0")"
: "${COLOOP_EXPECTED_SHA256:?Provide the SHA-256 of the currently deployed relay.mjs}"
[[ "$COLOOP_EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] || exit 2
test "$(id -u)" = 0
test -f /etc/coloop/relay.json
test -x /opt/coloop/node/bin/node
exec 9>/run/coloop-relay-update.lock
flock -n 9 || { echo 'Another update is running.' >&2; exit 2; }
current=$(sha256sum /opt/coloop/relay.mjs | cut -d ' ' -f 1)
target=$(sha256sum relay.mjs | cut -d ' ' -f 1)
if [[ "$current" == "$target" ]]; then
  echo 'ALREADY_CURRENT'
  exit 0
fi
[[ "$current" == "$COLOOP_EXPECTED_SHA256" ]] || {
  echo 'Deployed code changed; refusing to overwrite an unexpected version.' >&2
  exit 2
}
/opt/coloop/node/bin/node --check relay.mjs
install -d -m 700 /opt/coloop/backups
backup="/opt/coloop/backups/relay-$current.mjs"
if [[ -e "$backup" ]]; then
  [[ "$(sha256sum "$backup" | cut -d ' ' -f 1)" == "$current" ]] || exit 2
else
  install -m 600 /opt/coloop/relay.mjs "$backup"
fi
staged=$(mktemp /opt/coloop/relay-update.XXXXXX)
changed=0
rollback() {
  result=$?
  trap - EXIT
  if [[ "$result" != 0 && "$changed" == 1 ]]; then
    install -m 644 "$backup" "$staged"
    mv -f -- "$staged" /opt/coloop/relay.mjs
    systemctl restart coloop-relay || true
    echo 'UPDATE_FAILED_ROLLED_BACK; check service status.' >&2
  fi
  rm -f -- "$staged"
  exit "$result"
}
trap rollback EXIT
install -m 644 relay.mjs "$staged"
changed=1
mv -f -- "$staged" /opt/coloop/relay.mjs
systemctl restart coloop-relay
ready=0
for attempt in {1..20}; do
  if headers=$(curl --max-time 2 --silent --show-error --dump-header - --output /dev/null http://127.0.0.1:8787/healthz) &&
    printf '%s' "$headers" | tr -d '\r' | grep -q '^x-coloop-relay-version: 2026.10.31.1$' &&
    printf '%s' "$headers" | grep -q '^HTTP/1.1 401'; then
    ready=1
    break
  fi
  sleep 0.5
done
[[ "$ready" == 1 ]]
systemctl is-active --quiet coloop-relay
printf 'UPDATE_READY %s\n' "$target"
