#!/bin/bash
# Entrypoint script
# Retrieves secrets from Secrets Manager, sets environment variables, then starts mcp-grafana
#
# Required environment variables:
#   GRAFANA_SECRET_NAME - Secrets Manager secret name (JSON format: {"url":"...","token":"..."})
#   AWS_DEFAULT_REGION  - AWS region (default: ap-northeast-1)

set -euo pipefail

# AWS_DEFAULT_REGION is automatically set by AgentCore Runtime.
# The fallback is only used for local testing outside of AgentCore.
REGION="${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo ap-northeast-1)}"

# If GRAFANA_SECRET_NAME is set, retrieve from Secrets Manager
if [ -n "${GRAFANA_SECRET_NAME:-}" ]; then
  echo "Retrieving secret from Secrets Manager: ${GRAFANA_SECRET_NAME}" >&2

  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$GRAFANA_SECRET_NAME" \
    --region "$REGION" \
    --query 'SecretString' \
    --output text)

  export GRAFANA_URL=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
  export GRAFANA_SERVICE_ACCOUNT_TOKEN=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

  echo "Secret retrieved successfully" >&2
fi

exec mcp-grafana "$@"
