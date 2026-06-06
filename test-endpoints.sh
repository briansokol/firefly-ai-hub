#!/usr/bin/env bash
# test-endpoints.sh — Phase 0 sanity check.
# Confirms every node answers the OpenAI-compatible chat API over Tailscale.
#
# Usage:
#   chmod +x test-endpoints.sh
#   LITELLM_MASTER_KEY=sk-... ./test-endpoints.sh
# Override any host/model/port via env vars (see defaults below).

set -uo pipefail

# --- Tailscale MagicDNS names or IPs ---
FIREFLY="${FIREFLY:-firefly}"
LAPTOP="${LAPTOP:-framework}"
MAC="${MAC:-macbook}"

LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-changeme}"

# Lemonade moved its default port to 13305 in recent versions; older installs use 8000.
# Confirm with:  lemonade-server status
LEMONADE_PORT="${LEMONADE_PORT:-13305}"

# Model names exactly as each backend reports them:
#   Firefly/Mac:  ollama list
#   Laptop:       lemonade-server list
LEMONADE_MODEL="${LEMONADE_MODEL:-Qwen3-8B-GGUF}"
MAC_MODEL="${MAC_MODEL:-qwen3:30b}"

pass=0; fail=0

check () {
  local name="$1" url="$2" model="$3" auth="${4:-}"
  local data code
  data=$(printf '{"model":"%s","messages":[{"role":"user","content":"Reply with the single word: pong"}],"max_tokens":16}' "$model")
  local hdr=(-H "Content-Type: application/json")
  [ -n "$auth" ] && hdr+=(-H "Authorization: Bearer $auth")

  code=$(curl -sS -o /tmp/aitest_resp.json -w '%{http_code}' --max-time 30 \
           "${hdr[@]}" -d "$data" "$url" 2>/tmp/aitest_err) || code=000

  if [ "$code" = "200" ]; then
    printf '  \033[32m✅ %-18s\033[0m %s\n' "$name" "$url"
    pass=$((pass+1))
  else
    printf '  \033[31m❌ %-18s\033[0m %s  (HTTP %s)\n' "$name" "$url" "$code"
    head -2 /tmp/aitest_err 2>/dev/null | sed 's/^/       /'
    head -c 300 /tmp/aitest_resp.json 2>/dev/null | sed 's/^/       /'; echo
    fail=$((fail+1))
  fi
}

echo "== Firefly (RTX 3090) =="
check "Ollama direct"   "http://$FIREFLY:11434/v1/chat/completions" "qwen3:30b"
check "LiteLLM gateway" "http://$FIREFLY:4000/v1/chat/completions"  "fast" "$LITELLM_MASTER_KEY"

echo "== Framework 16 (NPU) =="
check "Lemonade NPU"    "http://$LAPTOP:$LEMONADE_PORT/api/v1/chat/completions" "$LEMONADE_MODEL" "lemonade"

echo "== MacBook Pro (M4 Max) =="
check "Ollama / MLX"    "http://$MAC:11434/v1/chat/completions" "$MAC_MODEL"

echo
echo "Passed: $pass   Failed: $fail"
[ "$fail" -eq 0 ] || exit 1
