FROM python:3.12-slim

WORKDIR /srv/app

COPY pyproject.toml README.md LICENSE ./
COPY src ./src
COPY prompts ./prompts
COPY schemas ./schemas
COPY workflows ./workflows

RUN python -m pip install --no-cache-dir ".[mcp]"

# The universal MCP server serves the same tools/resources over three
# transports: stdio (default), SSE, or streamable-http. Set TRANSPORT and
# MOUNT_PATH to expose it as a remote URL reachable from any MCP client.
ENV TRANSPORT=streamable-http
ENV MOUNT_PATH=/mcp
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "-m", "agentic_company.mcp_server", "--transport", "streamable-http", "--mount-path", "/mcp"]