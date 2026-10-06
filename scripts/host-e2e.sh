#!/usr/bin/env bash
# Host E2E (see docs/testing.md): the plugin inside a real `dsh web`, driven
# through headless Chrome.
#
# Boots a DeepSeek Harness web profile with this plugin installed and
# test/fixtures/host-e2e-profile copied in. Those files are fake
# credentials, never a real provider login. scripts/host-e2e-preload.mjs
# answers each planned provider request (exact method and URL) with a
# fixture and refuses every other connection that leaves loopback.
# scripts/host-e2e.mjs then checks the usage RPCs, the model picker, one
# streamed Codex reply, the usage pill and its dialog in the host's stats
# row, the page for slot crashes and non-loopback requests, and the
# provider request log.
#
# Usage:
#   DSH_VERSION=0.2.0-rc.2 bash scripts/host-e2e.sh
#   PLUGIN_SOURCE=/path/to/plugin.tgz bash scripts/host-e2e.sh   # default: this repo
#   HOST_E2E_ARTIFACTS=/some/dir bash scripts/host-e2e.sh         # keep evidence here
#   KEEP_SMOKE_HOME=1 bash scripts/host-e2e.sh                    # keep the temp profile
#
# Env:
#   DSH_VERSION        - harness version to boot (default: newest in dsh-versions.txt)
#   PLUGIN_SOURCE      - what `dsh plugin add` installs (default: this repo dir)
#   DSH_BIN            - dsh binary (default: the one npx installs for <version>)
#   CHROME_BIN         - Chrome or Chromium binary (default: google-chrome, then chromium)
#   HOST_E2E_ARTIFACTS - where evidence goes (default: a new temp dir, printed
#                        on failure and removed on success)
#
# Exit 0 on pass, 1 on a product failure (including the host refusing the
# plugin for its peers), 2 on a harness failure: the host did not boot, the
# driver could not reach a UI state after one retry, a setup command such as
# npx, mktemp, or cp failed, or `dsh plugin add` failed without a peer
# refusal, which its log cannot tell apart from a registry outage.
# The artifact dir always holds the driver's evidence (rpc/ and
# browser-attempt-N/); on failure it also gets web.log, plugin-add.log, and
# provider-requests.jsonl. The temp DSH home, and the TMPDIR the host runs
# with, are removed on exit unless KEEP_SMOKE_HOME=1 keeps the home.
set -Eeuo pipefail
# A command failing outside the explicit checks below is a setup problem,
# never a product finding, so it exits 2 instead of set -e's 1.
trap 'echo "HOST E2E HARNESS FAILURE: setup command failed at line $LINENO: $BASH_COMMAND" >&2; exit 2' ERR

# Inherited process environment wins over $DSH_HOME/.credentials.yaml.
# Drop these names so a developer shell cannot supply a real key.
unset OPENCODE_GO_API_KEY KIMI_CODING_API_KEY CURSOR_SUBSCRIPTION_OAUTH MINIMAX_API_KEY MINIMAX_CN_API_KEY || true
# Share millisecond bounds between the preload and driver, even across processes.
export HOST_E2E_FIXTURE_NOW="${HOST_E2E_FIXTURE_NOW:-$(node -e 'process.stdout.write(String(Date.now()))')}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DSH_VERSION="${DSH_VERSION:-$(grep -v '^#' "$REPO_ROOT/dsh-versions.txt" | grep -v '^[[:space:]]*$' | tail -1)}"
PLUGIN_SOURCE="${PLUGIN_SOURCE:-$REPO_ROOT}"
# Resolve the dsh binary once. Running dsh through npx would load the
# network preload into npx too, and npx's own registry lookups would then
# show up as refused requests.
if [[ -z "${DSH_BIN:-}" ]]; then
  DSH_BIN="$(npx --yes -p "@deepseek-ai/dsh@$DSH_VERSION" -c 'command -v dsh' | tail -1)"
fi
[[ -x "$DSH_BIN" ]] || { echo "HOST E2E HARNESS FAILURE: no dsh binary for $DSH_VERSION" >&2; exit 2; }
DSH_CLI="$DSH_BIN"

# Set before anything is allocated, so the trap below can run at any point:
# a failed mktemp must not strand the directories made before it.
E2E_HOME=""
HOST_TMP=""
ARTIFACTS=""
OWN_ARTIFACTS=0
WEB_PID=""
WEB_LOG=""
HOST_E2E_SEEN=""
FAILED=0

collect() {
  FAILED=1
  cp "$WEB_LOG" "$E2E_HOME/plugin-add.log" "$ARTIFACTS/" 2>/dev/null || true
  cp "$HOST_E2E_SEEN" "$ARTIFACTS/provider-requests.jsonl" 2>/dev/null || true
}

cleanup() {
  # Cleanup never changes the exit code the run already chose.
  trap - ERR
  set +e
  if [[ -n "$WEB_PID" ]] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_SMOKE_HOME:-0}" == "1" ]]; then
    [[ -z "$E2E_HOME" ]] || echo "KEEP_SMOKE_HOME=1: profile kept at $E2E_HOME"
  else
    [[ -z "$E2E_HOME" ]] || rm -rf "$E2E_HOME"
  fi
  [[ -z "$HOST_TMP" ]] || rm -rf "$HOST_TMP"
  if [[ "$OWN_ARTIFACTS" == "1" && "$FAILED" == "0" && -n "$ARTIFACTS" ]]; then
    rm -rf "$ARTIFACTS"
  fi
}
trap cleanup EXIT

E2E_HOME="$(mktemp -d "${TMPDIR:-/tmp}/dsh-e2e-XXXXXX")"
export DSH_HOME="$E2E_HOME"
if [[ -n "${HOST_E2E_ARTIFACTS:-}" ]]; then
  ARTIFACTS="$HOST_E2E_ARTIFACTS"
  OWN_ARTIFACTS=0
else
  ARTIFACTS="$(mktemp -d "${TMPDIR:-/tmp}/dsh-e2e-evidence-XXXXXX")"
  OWN_ARTIFACTS=1
fi
mkdir -p "$ARTIFACTS"
WEB_LOG="$E2E_HOME/web.log"
# The preload appends here; the driver and collect() read it.
export HOST_E2E_SEEN="$E2E_HOME/provider-requests.jsonl"
# The driver's fallback workspace goes here, so cleanup removes it.
export HOST_E2E_WORKSPACES="$E2E_HOME/workspaces"
# The host leaves scratch dirs (dsh-spill-*, dsh-subprocess-launch-*) in
# its TMPDIR. This one is removed with the run. It stays short under /tmp
# because the host and Chrome create Unix sockets there, whose paths are
# limited to 108 bytes.
HOST_TMP="$(mktemp -d /tmp/dsh-e2e-tmp-XXXXXX)"

# Harness failure: the host never got to a state worth asserting on.
harness_fail() {
  echo "HOST E2E HARNESS FAILURE: $1" >&2
  collect
  tail -40 "$WEB_LOG" >&2 2>/dev/null || true
  echo "evidence: $ARTIFACTS" >&2
  exit 2
}

echo "== host E2E: DSH $DSH_VERSION, plugin from $PLUGIN_SOURCE =="

# 1. Install the plugin into an isolated web profile, then copy in the fake
# profile. The credential provider reads .credentials.yaml at startup and the
# plugin reads auth.json on mount, so both exist before the process starts.
"$DSH_CLI" plugin --profile web add "$PLUGIN_SOURCE" > "$E2E_HOME/plugin-add.log" 2>&1 \
  || {
    if grep -qi "incompatible with dsh" "$E2E_HOME/plugin-add.log"; then
      collect
      tail -40 "$E2E_HOME/plugin-add.log" >&2 || true
      echo "HOST E2E PRODUCT FAILURE: DSH $DSH_VERSION refused the plugin's peers" >&2
      echo "evidence: $ARTIFACTS" >&2
      exit 1
    fi
    tail -40 "$E2E_HOME/plugin-add.log" >&2 || true
    harness_fail "plugin install failed without a peer refusal"
  }
mkdir -p "$E2E_HOME/plugins/subscriptions"
cp "$REPO_ROOT/test/fixtures/host-e2e-profile/.credentials.yaml" "$E2E_HOME/.credentials.yaml"
cp "$REPO_ROOT/test/fixtures/host-e2e-profile/plugins/subscriptions/auth.json" \
  "$E2E_HOME/plugins/subscriptions/auth.json"
chmod 600 "$E2E_HOME/.credentials.yaml" "$E2E_HOME/plugins/subscriptions/auth.json"

# 2. Point the host's first-use workspace at the temp home. A fresh profile
# then opens a workspace without the directory picker, and never touches
# ~/Documents. The E2E drives the picker only when this has no effect.
PATCH="$E2E_HOME/host-e2e.patch.yml"
cat > "$PATCH" <<YAML
- id: workspace-controller
  config:
    documentsDirectory: $E2E_HOME/documents
YAML

# 3. Boot the web UI on an OS-picked port with the network preload. The
# preload goes into dsh and its children only; the install above ran without it.
TMPDIR="$HOST_TMP" \
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import file://${SCRIPT_DIR}/host-e2e-preload.mjs" \
  "$DSH_CLI" --profile web --patch "$PATCH" --no-open --port 0 > "$WEB_LOG" 2>&1 &
WEB_PID=$!

URL=""
for _ in $(seq 1 60); do
  kill -0 "$WEB_PID" 2>/dev/null || harness_fail "web UI exited during boot"
  URL="$(grep -oE 'http://[^[:space:]"'\'']+' "$WEB_LOG" 2>/dev/null | head -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 2
done
[[ -n "$URL" ]] || harness_fail "no serving URL appeared in web.log after 120s"
JAR="$E2E_HOME/cookies.txt"
CODE="$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' --max-time 15 "$URL" || true)"
[[ "$CODE" == "303" ]] || harness_fail "token handshake answered HTTP $CODE, expected 303"
BASE="${URL%%\?*}"
BASE="${BASE%/}"
echo "ok: web UI serving at $BASE with the fixture profile"

# 4. Drive it. The driver exits 1 only for a product failure; any other
# non-zero code (2, node missing, killed by a signal) is a harness failure.
status=0
node "$SCRIPT_DIR/host-e2e.mjs" "$BASE" "$JAR" "$HOST_E2E_SEEN" "$ARTIFACTS" || status=$?
if (( status != 0 )); then
  collect
  echo "--- web.log tail ---" >&2
  tail -40 "$WEB_LOG" >&2 || true
  (( status == 1 )) || { echo "HOST E2E HARNESS FAILURE: the driver exited ${status}" >&2; exit 2; }
  exit 1
fi

# 5. No silent mount failures in the server log.
if grep -qiE "name mismatch|failed to load plugin|plugin failed|Cannot find module|ERR_MODULE_NOT_FOUND" "$WEB_LOG"; then
  collect
  echo "HOST E2E PRODUCT FAILURE: web.log shows plugin load or patch failures" >&2
  exit 1
fi
echo "HOST E2E PASS: DSH $DSH_VERSION"
