#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# test-worker.sh — Smoke tests for the wiki3-ai-sync-proxy worker
#
# Usage:
#   bash test-worker.sh [worker-url]
#
# Defaults to https://wiki3-ai-sync-proxy.jim-2ad.workers.dev
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

WORKER_URL="${1:-https://wiki3-ai-sync-proxy.jim-2ad.workers.dev}"
PASS=0
FAIL=0
ORIGIN="https://wiki3-ai.github.io"

pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

check_status() {
  local label="$1" url="$2" expected="$3" method="${4:-GET}"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" \
    -H "Origin: $ORIGIN" "$url")
  if [[ "$status" == "$expected" ]]; then
    pass "$label (HTTP $status)"
  else
    fail "$label — expected $expected, got $status"
  fi
}

check_json_field() {
  local label="$1" url="$2" field="$3" expected="$4" method="${5:-GET}" body="${6:-}"
  local value
  if [[ -n "$body" ]]; then
    value=$(curl -s -X "$method" -H "Origin: $ORIGIN" \
      -H "Content-Type: application/json" -d "$body" "$url" | \
      python3 -c "import sys,json; print(json.load(sys.stdin).get('$field',''))")
  else
    value=$(curl -s -X "$method" -H "Origin: $ORIGIN" "$url" | \
      python3 -c "import sys,json; print(json.load(sys.stdin).get('$field',''))")
  fi
  if [[ "$value" == "$expected" ]]; then
    pass "$label ($field=$value)"
  else
    fail "$label — expected $field=$expected, got $field=$value"
  fi
}

check_cors_header() {
  local label="$1" url="$2" method="${3:-GET}"
  local acao
  acao=$(curl -s -D- -o /dev/null -X "$method" \
    -H "Origin: $ORIGIN" "$url" | \
    grep -i '^access-control-allow-origin:' | tr -d '\r' | awk '{print $2}')
  if [[ "$acao" == "$ORIGIN" || "$acao" == "*" ]]; then
    pass "$label (ACAO: $acao)"
  else
    fail "$label — missing or wrong Access-Control-Allow-Origin: '$acao'"
  fi
}

echo "Testing worker at: $WORKER_URL"
echo "Origin: $ORIGIN"
echo ""

# ── 1. Health check ──────────────────────────────────────────────────
echo "1. Health check (/oauth/status)"
check_status  "GET returns 200"     "$WORKER_URL/oauth/status" "200"
check_json_field "ok is true"       "$WORKER_URL/oauth/status" "ok" "True"
check_json_field "hasClientId"      "$WORKER_URL/oauth/status" "hasClientId" "True"
check_cors_header "CORS header"     "$WORKER_URL/oauth/status"
echo ""

# ── 2. CORS preflight ───────────────────────────────────────────────
echo "2. CORS preflight (OPTIONS)"
status=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: POST" \
  "$WORKER_URL/oauth/status")
if [[ "$status" == "204" ]]; then
  pass "OPTIONS returns 204"
else
  fail "OPTIONS — expected 204, got $status"
fi
check_cors_header "Preflight CORS header" "$WORKER_URL/oauth/status" "OPTIONS"
echo ""

# ── 2b. CORS preflight for API proxy (X-GitHub-Api-Version) ─────────
echo "2b. CORS preflight for API proxy"
preflight_url="$WORKER_URL/proxy/https://api.github.com/repos/wiki3-ai/jupyterlite-demo/git/ref/heads/gh-pages"
preflight_headers=$(curl -s -D- -o /dev/null -X OPTIONS \
  -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: Authorization,X-GitHub-Api-Version,Accept,Content-Type" \
  "$preflight_url")
preflight_status=$(echo "$preflight_headers" | head -1 | awk '{print $2}')
if [[ "$preflight_status" == "204" ]]; then
  pass "OPTIONS returns 204"
else
  fail "OPTIONS — expected 204, got $preflight_status"
fi
allow_hdrs=$(echo "$preflight_headers" | grep -i '^access-control-allow-headers:' | tr -d '\r')
if echo "$allow_hdrs" | grep -qi 'x-github-api-version'; then
  pass "Allow-Headers includes X-GitHub-Api-Version"
else
  fail "Missing X-GitHub-Api-Version in Allow-Headers: $allow_hdrs"
fi
allow_methods=$(echo "$preflight_headers" | grep -i '^access-control-allow-methods:' | tr -d '\r')
if echo "$allow_methods" | grep -q 'PATCH'; then
  pass "Allow-Methods includes PATCH"
else
  fail "Missing PATCH in Allow-Methods: $allow_methods"
fi
echo ""

# ── 3. Git proxy — public repo smart HTTP discovery ─────────────────
echo "3. Git proxy (/proxy/ → github.com)"
check_status "info/refs returns 200" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack" "200"
check_cors_header "Proxy CORS header" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack"

# Verify it returns git smart-HTTP content
content_type=$(curl -s -D- -o /dev/null \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack" | \
  grep -i '^content-type:' | tr -d '\r')
if echo "$content_type" | grep -qi "git-upload-pack"; then
  pass "Content-Type is git smart HTTP ($content_type)"
else
  fail "Unexpected Content-Type: $content_type"
fi
echo ""

# ── 4. OAuth Device Flow — start ────────────────────────────────────
echo "4. OAuth Device Flow (/oauth/device)"
check_status "POST returns 200" \
  "$WORKER_URL/oauth/device" "200" "POST" 

device_resp=$(curl -s -X POST -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"public_repo"}' \
  "$WORKER_URL/oauth/device")
echo "  Response: $device_resp"

user_code=$(echo "$device_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('user_code',''))" 2>/dev/null)
device_code=$(echo "$device_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('device_code',''))" 2>/dev/null)
verification_uri=$(echo "$device_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verification_uri',''))" 2>/dev/null)

if [[ -n "$user_code" && -n "$device_code" ]]; then
  pass "Got user_code=$user_code, device_code=${device_code:0:8}…"
else
  fail "Missing user_code or device_code"
fi
if [[ "$verification_uri" == *"github.com"* ]]; then
  pass "verification_uri points to GitHub ($verification_uri)"
else
  fail "Unexpected verification_uri: $verification_uri"
fi
echo ""

# ── 5. OAuth Token poll (should get authorization_pending) ───────────
echo "5. OAuth Token poll (/oauth/token)"
token_resp=$(curl -s -X POST -H "Origin: $ORIGIN" \
  -H "Content-Type: application/json" \
  -d "{\"device_code\":\"$device_code\"}" \
  "$WORKER_URL/oauth/token")
echo "  Response: $token_resp"

error_val=$(echo "$token_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null)
if [[ "$error_val" == "authorization_pending" ]]; then
  pass "Token poll returns authorization_pending (expected)"
else
  fail "Unexpected token response error: $error_val"
fi
check_cors_header "Token poll CORS header" "$WORKER_URL/oauth/token" "POST"
echo ""

# ── 6. 404 on unknown route ─────────────────────────────────────────
echo "6. Unknown route"
check_status "Returns 404" "$WORKER_URL/nonexistent" "404"
echo ""

# ── Summary ──────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
fi
