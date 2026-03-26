#!/bin/bash
# Connect to AgentCore Runtime via MCP Inspector CLI mode
#
# Usage:
#   ./scripts/mcp-inspect.sh                    # Run tools/list
#   ./scripts/mcp-inspect.sh tools/list         # Run tools/list
#   ./scripts/mcp-inspect.sh resources/list     # Run resources/list

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load environment variables from .env
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

# Required environment variable check
for var in AGENTCORE_RUNTIME_ARN COGNITO_TOKEN_ENDPOINT COGNITO_CLIENT_ID COGNITO_CLIENT_SECRET; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set. Check your .env file." >&2
    exit 1
  fi
done

SCOPE="${COGNITO_SCOPE:-mcp-api/access}"
REGION="${AGENTCORE_REGION:-$(aws configure get region)}"
METHOD="${1:-tools/list}"

# Obtain bearer token from Cognito
echo "Obtaining token..."
TOKEN=$(curl -s -X POST "$COGNITO_TOKEN_ENDPOINT" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$COGNITO_CLIENT_ID&client_secret=$COGNITO_CLIENT_SECRET&scope=$SCOPE" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

if [ -z "$TOKEN" ]; then
  echo "Error: Failed to obtain token" >&2
  exit 1
fi
echo "Token obtained successfully"

# Build AgentCore Runtime URL
ENCODED_ARN=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${AGENTCORE_RUNTIME_ARN}', safe=''))")
ENDPOINT="https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${ENCODED_ARN}/invocations?qualifier=DEFAULT"

echo "Endpoint: $ENDPOINT"
echo "Method: $METHOD"
echo ""

# Run MCP Inspector CLI mode
npx @modelcontextprotocol/inspector --cli "$ENDPOINT" \
  --transport http \
  --header "Authorization: Bearer $TOKEN" \
  --method "$METHOD"
