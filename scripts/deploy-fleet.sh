#!/usr/bin/env bash
# =============================================================================
# Senpi Agent Fleet Deployer
# =============================================================================
# Deploys multiple Senpi agents on Railway from a single config file.
# Each agent gets its own Railway project with a unique model, Senpi token,
# and Telegram bot.
#
# Prerequisites:
#   1. Install Railway CLI: npm install -g @railway/cli
#   2. Login: railway login
#   3. Copy fleet-config.example.json to fleet-config.json and fill in your values
#   4. Run: bash scripts/deploy-fleet.sh
#
# What it does:
#   - Creates a new Railway project per agent
#   - Deploys your fork of the Senpi template
#   - Sets all env vars (model, provider, Senpi token, Telegram bot, etc.)
#   - Adds a volume at /data for persistence
#   - Enables public networking
#
# =============================================================================

set -euo pipefail

CONFIG_FILE="${1:-scripts/fleet-config.json}"
REPO="shnoodles/senpi-hyperclaw-railway-template"

if ! command -v railway &> /dev/null; then
  echo "❌ Railway CLI not found. Install with: npm install -g @railway/cli"
  exit 1
fi

if ! railway whoami &> /dev/null; then
  echo "❌ Not logged in to Railway. Run: railway login"
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Config file not found: $CONFIG_FILE"
  echo "   Copy scripts/fleet-config.example.json to scripts/fleet-config.json and fill in your values."
  exit 1
fi

# Check for jq
if ! command -v jq &> /dev/null; then
  echo "❌ jq not found. Install with: brew install jq (mac) or apt install jq (linux)"
  exit 1
fi

AGENT_COUNT=$(jq '.agents | length' "$CONFIG_FILE")
echo "🚀 Deploying $AGENT_COUNT agents from $CONFIG_FILE"
echo ""

# Read shared config
SHARED_SETUP_PASSWORD=$(jq -r '.shared.setup_password // ""' "$CONFIG_FILE")
SHARED_TOGETHER_KEY=$(jq -r '.shared.together_api_key // ""' "$CONFIG_FILE")
SHARED_ANTHROPIC_KEY=$(jq -r '.shared.anthropic_api_key // ""' "$CONFIG_FILE")

for i in $(seq 0 $(($AGENT_COUNT - 1))); do
  AGENT_NAME=$(jq -r ".agents[$i].name" "$CONFIG_FILE")
  AI_PROVIDER=$(jq -r ".agents[$i].ai_provider" "$CONFIG_FILE")
  AI_API_KEY=$(jq -r ".agents[$i].ai_api_key // \"\"" "$CONFIG_FILE")
  MODEL=$(jq -r ".agents[$i].model // \"\"" "$CONFIG_FILE")
  SENPI_AUTH_TOKEN=$(jq -r ".agents[$i].senpi_auth_token" "$CONFIG_FILE")
  TELEGRAM_BOT_TOKEN=$(jq -r ".agents[$i].telegram_bot_token" "$CONFIG_FILE")
  TELEGRAM_USERID=$(jq -r ".agents[$i].telegram_userid // \"\"" "$CONFIG_FILE")

  # Fall back to shared keys if agent-level key is empty
  if [ -z "$AI_API_KEY" ]; then
    if [ "$AI_PROVIDER" = "together" ] && [ -n "$SHARED_TOGETHER_KEY" ]; then
      AI_API_KEY="$SHARED_TOGETHER_KEY"
    elif [ "$AI_PROVIDER" = "anthropic" ] && [ -n "$SHARED_ANTHROPIC_KEY" ]; then
      AI_API_KEY="$SHARED_ANTHROPIC_KEY"
    fi
  fi

  SETUP_PASSWORD="${SHARED_SETUP_PASSWORD:-$(openssl rand -hex 16)}"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🤖 Agent $((i+1))/$AGENT_COUNT: $AGENT_NAME"
  echo "   Provider: $AI_PROVIDER"
  echo "   Model:    $MODEL"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # 1. Create a new Railway project
  echo "   📁 Creating Railway project..."
  PROJECT_OUTPUT=$(railway init --name "$AGENT_NAME" --json 2>/dev/null || true)
  PROJECT_ID=$(echo "$PROJECT_OUTPUT" | jq -r '.id // empty' 2>/dev/null || true)

  if [ -z "$PROJECT_ID" ]; then
    echo "   ⚠️  Could not parse project ID. Trying interactive mode..."
    railway init --name "$AGENT_NAME"
    echo "   Please run 'railway link' to select the project, then re-run this script."
    continue
  fi

  echo "   ✅ Project created: $PROJECT_ID"

  # 2. Link to the project
  railway link --project "$PROJECT_ID" --environment production

  # 3. Add the GitHub repo as a service
  echo "   📦 Adding service from $REPO..."
  railway add --repo "$REPO" --service "$AGENT_NAME"

  # 4. Link to the service
  railway service "$AGENT_NAME"

  # 5. Add a volume for persistence
  echo "   💾 Adding volume..."
  railway volume add --mount-path "/data" 2>/dev/null || echo "   ⚠️  Volume may already exist"

  # 6. Set environment variables
  echo "   🔧 Setting environment variables..."
  railway variables \
    --set "AI_PROVIDER=$AI_PROVIDER" \
    --set "AI_API_KEY=$AI_API_KEY" \
    --set "AI_MODEL=$MODEL" \
    --set "SENPI_AUTH_TOKEN=$SENPI_AUTH_TOKEN" \
    --set "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN" \
    --set "SETUP_PASSWORD=$SETUP_PASSWORD" \
    --set "OPENCLAW_STATE_DIR=/data/.openclaw" \
    --set "OPENCLAW_WORKSPACE_DIR=/data/workspace" \
    --set "SENPI_STATE_DIR=/data/.openclaw/senpi-state"

  if [ -n "$TELEGRAM_USERID" ]; then
    railway variables --set "TELEGRAM_USERID=$TELEGRAM_USERID"
  fi

  # 7. Generate a domain
  echo "   🌐 Generating domain..."
  railway domain 2>/dev/null || echo "   ⚠️  Domain may need manual setup"

  echo "   ✅ $AGENT_NAME deployed!"
  echo "   📝 Setup password: $SETUP_PASSWORD"
  echo "   🔗 Model will default to: $MODEL"
  echo "   💡 Once live, switch model with: /model $MODEL"
  echo ""

  # Unlink so next iteration starts clean
  railway unlink 2>/dev/null || true

done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Fleet deployment complete! $AGENT_COUNT agents deployed."
echo ""
echo "Next steps:"
echo "  1. Send /start to each Telegram bot"
echo "  2. Each agent will auto-onboard and message you when ready"
echo "  3. Switch models with /model <model-string> if needed"
echo "  4. Start trading and compare results!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
