#!/bin/bash
# =============================================================================
# Startup script: LiteLLM proxy + OpenClaw gateway
# Place this at: scripts/start-with-litellm.sh
# =============================================================================
set -e

echo "================================================"
echo "  OpenClaw + LiteLLM Vertex AI Proxy Launcher"
echo "================================================"

# ---------------------------------------------------------------------------
# 1. Verify vertex-openai-proxy env vars are set
#    (GCP authentication is handled by the proxy, not LiteLLM)
# ---------------------------------------------------------------------------
LITELLM_CONFIG="/app/litellm_config.yaml"

export VERTEX_PROXY_URL="${VERTEX_PROXY_URL:-https://vertex-openai-proxy-production.up.railway.app/v1}"
echo "[✓] Vertex proxy URL: $VERTEX_PROXY_URL"

if [ -z "$VERTEX_API_KEY" ]; then
  echo "[!] WARNING: VERTEX_API_KEY is not set."
  echo "    LiteLLM will not be able to authenticate with the vertex-openai-proxy."
  echo "    Set this env var to the PROXY_API_KEY configured on the proxy service."
fi

# ---------------------------------------------------------------------------
# 3. Set LiteLLM master key (used by OpenClaw to authenticate to the proxy)
# ---------------------------------------------------------------------------
export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-litellm-$(head -c 16 /dev/urandom | xxd -p)}"
echo "[✓] LiteLLM master key configured"

# ---------------------------------------------------------------------------
# 4. Start LiteLLM proxy in the background on port 4000
# ---------------------------------------------------------------------------
echo "[→] Starting LiteLLM proxy on port 4000..."
litellm --config "$LITELLM_CONFIG" --port 4000 --host 0.0.0.0 &
LITELLM_PID=$!

# Wait for LiteLLM to be ready (use /health/readiness which doesn't require auth)
echo "[→] Waiting for LiteLLM proxy to be ready..."
for i in $(seq 1 30); do
  if curl -s http://localhost:4000/health/readiness 2>/dev/null | grep -q "connected"; then
    echo "[✓] LiteLLM proxy is healthy and running (PID: $LITELLM_PID)"
    break
  fi
  # Fallback: check if process is alive and port is listening
  if [ $i -ge 5 ] && kill -0 $LITELLM_PID 2>/dev/null && curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/health 2>/dev/null | grep -q "401\|200"; then
    echo "[✓] LiteLLM proxy is running (PID: $LITELLM_PID)"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[✗] LiteLLM proxy failed to start after 30 seconds"
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 5. Set env vars for auto-onboard (initial setup uses openai provider)
#    After onboard completes, the server.js bootstrap will patch openclaw.json
#    with the custom LiteLLM provider config (see step 6).
# ---------------------------------------------------------------------------
export AI_PROVIDER="${AI_PROVIDER:-openai}"
export AI_API_KEY="$LITELLM_MASTER_KEY"
export AI_MODEL="${AI_MODEL:-gemma-4-31b-it}"

echo "[✓] OpenClaw AI env vars set:"
echo "    Provider:  $AI_PROVIDER"
echo "    Model:     $AI_MODEL"

# ---------------------------------------------------------------------------
# 6. Patch openclaw.json to add custom LiteLLM provider with correct baseUrl
#    This runs AFTER onboarding creates the initial config file.
#    We use a background watcher that waits for openclaw.json to exist,
#    then injects the vertex-litellm provider config.
# ---------------------------------------------------------------------------
OPENCLAW_CONFIG="${OPENCLAW_STATE_DIR:-/data/.openclaw}/openclaw.json"

patch_openclaw_config() {
  echo "[→] Waiting for openclaw.json to be created by onboarding..."
  for i in $(seq 1 120); do
    if [ -f "$OPENCLAW_CONFIG" ]; then
      echo "[✓] Found openclaw.json, patching with LiteLLM provider..."

      # Use node to safely merge JSON config
      node -e "
const fs = require('fs');
const configPath = '${OPENCLAW_CONFIG}';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Add custom LiteLLM provider under models.providers
if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};

config.models.providers['vertex-litellm'] = {
  baseUrl: 'http://localhost:4000/v1',
  apiKey: '${LITELLM_MASTER_KEY}',
  api: 'openai-completions',
  models: [
    {
      id: '${AI_MODEL}',
      name: 'Gemma 4 31B IT (Vertex AI)',
      reasoning: false,
      input: ['text'],
      contextWindow: 131072,
      maxTokens: 8192
    }
  ]
};

// Set the default agent model to use our custom provider
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
config.agents.defaults.model = { primary: 'vertex-litellm/${AI_MODEL}' };

// Also set in agents.list if it exists
if (config.agents && config.agents.list) {
  for (const [name, agent] of Object.entries(config.agents.list)) {
    if (agent.model) {
      agent.model.primary = 'vertex-litellm/${AI_MODEL}';
    } else {
      agent.model = { primary: 'vertex-litellm/${AI_MODEL}' };
    }
  }
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('[✓] openclaw.json patched successfully');
console.log('    Provider: vertex-litellm');
console.log('    Base URL: http://localhost:4000/v1');
console.log('    Model:    vertex-litellm/${AI_MODEL}');
" 2>&1

      return 0
    fi
    sleep 1
  done
  echo "[!] WARNING: openclaw.json not found after 120 seconds, skipping patch"
  return 1
}

# Run the patcher in the background so it doesn't block server startup
patch_openclaw_config &
PATCHER_PID=$!

# ---------------------------------------------------------------------------
# 7. Start the original OpenClaw entry point
# ---------------------------------------------------------------------------
echo "[→] Starting OpenClaw gateway..."
exec node /app/src/server.js
