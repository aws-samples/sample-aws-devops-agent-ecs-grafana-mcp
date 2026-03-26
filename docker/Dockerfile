# mcp-grafana container for AgentCore Runtime
# Auto-detects architecture for x86_64 / ARM64 support
FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a

WORKDIR /app

# Install required packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl ca-certificates python3 unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (architecture auto-detection)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip"; \
    else \
      CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip"; \
    fi && \
    curl -sL "$CLI_URL" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && \
    /tmp/aws/install && \
    rm -rf /tmp/awscliv2.zip /tmp/aws

# Download mcp-grafana v0.8.2 binary (architecture auto-detection)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
      MCP_URL="https://github.com/grafana/mcp-grafana/releases/download/v0.8.2/mcp-grafana_Linux_arm64.tar.gz"; \
    else \
      MCP_URL="https://github.com/grafana/mcp-grafana/releases/download/v0.8.2/mcp-grafana_Linux_x86_64.tar.gz"; \
    fi && \
    curl -sL "$MCP_URL" -o /tmp/mcp-grafana.tar.gz && \
    tar -xzf /tmp/mcp-grafana.tar.gz -C /tmp && \
    mv /tmp/mcp-grafana /usr/local/bin/mcp-grafana && \
    chmod +x /usr/local/bin/mcp-grafana && \
    rm /tmp/mcp-grafana.tar.gz

COPY entrypoint.sh /app/entrypoint.sh

# Run as non-root user
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup appuser
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "-sf", "http://localhost:8000/healthz"]

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["-t", "streamable-http", "--address", "0.0.0.0:8000"]
