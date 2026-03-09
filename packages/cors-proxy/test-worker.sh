#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# test-worker.sh — Smoke tests for the wiki3-ai-sync-proxy worker
#
# Tests:
#   1. Health check
#   2. CORS preflight (basic)
#   3. CORS preflight for API proxy (X-GitHub-Api-Version)
#   4. Git smart HTTP proxy (info/refs)
#   5. Route allowlist — blocked routes
#   6. OAuth authorize redirect
#   7. Unknown route → 404
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

status_json=$(curl -s -H "Origin: $ORIGIN" "$WORKER_URL/oauth/status")
ok=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',''))" 2>/dev/null)
if [[ "$ok" == "True" ]]; then
  pass "ok is true"
else
  fail "ok is not true: $ok"
fi

hasClientId=$(echo "$status_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hasClientId',''))" 2>/dev/null)
if [[ "$hasClientId" == "True" ]]; then
  pass "hasClientId is true (OAuth configured)"
else
  fail "hasClientId is false"
fi

check_cors_header "CORS header" "$WORKER_URL/oauth/status"
echo ""

# ── 2. CORS preflight (basic) ───────────────────────────────────────
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

# ── 3. CORS preflight for API proxy (X-GitHub-Api-Version) ──────────
echo "3. CORS preflight for API proxy"
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

# ── 4. Git proxy — allowed route ────────────────────────────────────
echo "4. Git proxy — allowed route (/proxy/ → github.com)"
check_status "info/refs returns 200" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack" "200"
check_cors_header "Proxy CORS header" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack"

content_type=$(curl -s -D- -o /dev/null \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-upload-pack" | \
  grep -i '^content-type:' | tr -d '\r')
if echo "$content_type" | grep -qi "git-upload-pack"; then
  pass "Content-Type is git smart HTTP"
else
  fail "Unexpected Content-Type: $content_type"
fi
echo ""

# ── 5. Route allowlist — blocked routes ──────────────────────────────
echo "5. Route allowlist — blocked routes"

# git-receive-pack should be blocked
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/wiki3-ai/jupyterlite-demo.git/info/refs?service=git-receive-pack")
if [[ "$status" == "403" ]]; then
  pass "git-receive-pack blocked (403)"
else
  fail "git-receive-pack should be 403, got $status"
fi

# DELETE on refs should be blocked
status=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/https://api.github.com/repos/wiki3-ai/jupyterlite-demo/git/refs/heads/gh-pages")
if [[ "$status" == "403" ]]; then
  pass "DELETE refs blocked (403)"
else
  fail "DELETE refs should be 403, got $status"
fi

# Repo admin API should be blocked
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/https://api.github.com/repos/wiki3-ai/jupyterlite-demo")
if [[ "$status" == "403" ]]; then
  pass "GET repo admin API blocked (403)"
else
  fail "GET repo admin should be 403, got $status"
fi

# User API should be blocked
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/https://api.github.com/user")
if [[ "$status" == "403" ]]; then
  pass "GET /user blocked (403)"
else
  fail "GET /user should be 403, got $status"
fi

# Non-GitHub host should be blocked
status=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Origin: $ORIGIN" \
  "$WORKER_URL/proxy/https://evil.com/steal-tokens")
if [[ "$status" == "403" ]]; then
  pass "Non-GitHub host blocked (403)"
else
  fail "Non-GitHub host should be 403, got $status"
fi
echo ""

# ── 6. OAuth authorize redirect ─────────────────────────────────────
echo "6. OAuth authorize redirect"
redirect_url=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "$WORKER_URL/oauth/authorize?nonce=test123&return_origin=$ORIGIN")
if echo "$redirect_url" | grep -q 'github.com/login/oauth/authorize'; then
  pass "Redirects to GitHub OAuth"
else
  fail "Expected redirect to github.com/login/oauth/authorize, got: $redirect_url"
fi
if echo "$redirect_url" | grep -q 'scope=public_repo'; then
  pass "Scope is public_repo"
else
  fail "Missing scope=public_repo in redirect URL"
fi
if echo "$redirect_url" | grep -q 'redirect_uri='; then
  pass "Has redirect_uri (callback URL)"
else
  fail "Missing redirect_uri in redirect URL"
fi
echo ""

# ── 7. Unknown route → 404 ──────────────────────────────────────────
echo "7. Unknown route"
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
