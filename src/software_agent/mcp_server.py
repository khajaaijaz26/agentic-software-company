"""Public Software Agent MCP compatibility module."""

from agentic_company.mcp_server import *  # noqa: F401,F403
from agentic_company.mcp_server import main


if __name__ == "__main__":
    raise SystemExit(main())
