# Installation & Integration Guide

This guide covers every way to install and use the Agentic Software Company,
from plain terminals to AI coding agents, IDEs, and remote/universal MCP.

> **What "universal" means here.** The repository ships **one MCP server**
> (`src/agentic_company/mcp_server.py`) that exposes the same tools,
> resources, and prompts over three standard transports — `stdio`, `sse`, and
> `streamable-http`. Every MCP-compatible platform below points at that same
> server; only the connection snippet differs. There is nothing platform-
> specific inside the server itself.

---

## 1. System requirements

- **Python 3.10+** (tested through 3.14) — the core package has **zero runtime
  dependencies**.
- **[uv](https://docs.astral.sh/uv/)** (recommended) *or* `pip` for the MCP
  adapter. The MCP server itself needs the `mcp` SDK, declared as the optional
  `mcp` extra.
- **git** to clone the repository.

---

## 2. Get the code

```bash
git clone https://github.com/khajaaijaz26/agentic-software-company.git
cd agentic-software-company
```

---

## 3. Install

Choose whichever matches your environment.

### 3a. Plain Python (no dependencies, core platform only)

```bash
python -m pip install -e .
```

That gives you the CLI:

```bash
# Begin a governed project
agentic-company init-project my-app "you@example.com"

# Dispatch a task to a specialist agent (stubbed dispatcher)
agentic-company dispatch technical-lead "plan the delivery"

# Print the append-only audit trail
agentic-company audit <project_id>
```

Or run the CLI without installing:

```bash
export PYTHONPATH=src            # bash/zsh/macOS/Linux
# PowerShell: $env:PYTHONPATH = "src"
python -m agentic_company init-project my-app you@example.com
```

### 3b. With the MCP adapter (recommended)

```bash
# With uv:
uv venv && uv pip install ".[mcp]"

# With pip:
python -m pip install ".[mcp]"
```

Verify the MCP server boots and advertises its capabilities:

```bash
# Streams the JSON-RPC handshake to stdout — silence while waiting is normal
python -m agentic_company.mcp_server
#   or
agentic-company-mcp
```

Quick capability check:

```bash
python -c "from agentic_company import mcp_server; print('MCP server imports OK')"
```

---

## 4. One server, three transports (the "universal MCP")

The same server speaks every MCP transport. Pick the one your platform wants.

| Transport          | Use when                                              | Command                                    |
| ------------------ | ----------------------------------------------------- | ------------------------------------------ |
| `stdio`            | Local terminal agents and most IDE integrations       | `python -m agentic_company.mcp_server`     |
| `sse`              | Remote URL, event-streaming clients                   | `python -m agentic_company.mcp_server --transport sse --mount-path /mcp` |
| `streamable-http`  | Modern remote clients, containers, multi-client fleets | `python -m agentic_company.mcp_server --transport streamable-http --mount-path /mcp` |

Run it remotely inside Docker so **any** platform — on any machine — connects
to the same governed company:

```bash
docker build -t agentic-company-mcp .
docker run -p 8000:8000 agentic-company-mcp
# streamable-http endpoint: http://localhost:8000/mcp
```

---

## 5. Universal connection snippets

Every snippet below launches the **same** MCP server. Choose the block for
your platform, or use the pre-made files in [`configs/`](configs/).

### A. Terminal AI agent (CLI)

Register once per session (example):

```bash
your-agent-cli mcp add agentic-software-company -- \
  uv run --with "mcp[cli]" --with "agentic-company[mcp]" mcp run src/agentic_company/mcp_server.py
```

### B. Claude Code

Claude Code reads `.mcp.json` from the project root — **already committed** in
this repo. If you use a global install instead:

```bash
claude mcp add agentic-software-company -- \
  uv run --with "mcp[cli]" --with "agentic-company[mcp]" mcp run src/agentic_company/mcp_server.py
```

Verify inside a session with `/mcp`, then ask:

```
Begin a project named "order-service", dispatch a delivery task to the
technical-lead, then show me the audit trail.
```

### C. Codex (OpenAI)

Add to `~/.codex/config.toml` (see [`configs/codex-config.toml`](configs/codex-config.toml)):

```toml
[mcp_servers.agentic-software-company]
command = "uv"
args = ["run", "--with", "mcp[cli]", "--with", "agentic-company[mcp]", "mcp", "run", "src/agentic_company/mcp_server.py"]
```

Or add it interactively:

```bash
codex mcp add agentic-software-company -- \
  uv run --with "mcp[cli]" --with "agentic-company[mcp]" mcp run src/agentic_company/mcp_server.py
```

### D. Cursor

Create `.cursor/mcp.json` (see [`configs/cursor-mcp.json`](configs/cursor-mcp.json)):

```json
{
  "mcpServers": {
    "agentic-software-company": {
      "command": "uv",
      "args": ["run", "--with", "mcp[cli]", "--with", "agentic-company[mcp]", "mcp", "run", "src/agentic_company/mcp_server.py"]
    }
  }
}
```

### E. VS Code (Copilot, Agent mode, VS Code 1.99+)

Create `.vscode/mcp.json` (see [`configs/vscode-mcp.json`](configs/vscode-mcp.json)):

```json
{
  "servers": {
    "agentic-software-company": {
      "type": "stdio",
      "command": "uv",
      "args": ["run", "--with", "mcp[cli]", "--with", "agentic-company[mcp]", "mcp", "run", "src/agentic_company/mcp_server.py"]
    }
  }
}
```

### F. Claude Desktop

Add to your Claude Desktop config (see
[`configs/claude-desktop-config.json`](configs/claude-desktop-config.json)):

```json
{
  "mcpServers": {
    "agentic-software-company": {
      "command": "uv",
      "args": ["run", "--with", "mcp[cli]", "--with", "agentic-company[mcp]", "mcp", "run", "src/agentic_company/mcp_server.py"]
    }
  }
}
```

### G. Windsurf

Use [`configs/windsurf-mcp.json`](configs/windsurf-mcp.json) — same shape as
Cursor's `mcpServers` block.

### H. OpenCode

OpenCode's config lives in `opencode.jsonc` (see
[`configs/opencode.jsonc`](configs/opencode.jsonc)):

```jsonc
{
  "mcp": {
    "agentic-software-company": {
      "type": "local",
      "command": ["uv", "run", "--with", "mcp[cli]", "--with", "agentic-company[mcp]", "mcp", "run", "src/agentic_company/mcp_server.py"],
      "enabled": true
    }
  }
}
```

### I. Remote / universal (any MCP client over HTTP)

Point any MCP client at the containerized streamable-http endpoint:

```json
{
  "mcpServers": {
    "agentic-software-company": {
      "type": "http",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

---

## 6. What the MCP server exposes

Once connected, your agent automatically gains:

**Tools (8)**

| Tool               | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `begin_project`    | Create a governed project record                    |
| `assign_task`      | Build a bound task envelope for a specialist role   |
| `complete_task`    | Record the executing agent's result envelope        |
| `request_approval` | Raise a human approval gate (G2/G3/G4)              |
| `resolve_approval` | Grant/deny a pending approval as an approver        |
| `audit`            | Return the append-only event log for a project      |
| `list_roles`       | List all 25 specialist roles + prompt files         |
| `list_workflows`   | List governed workflows (delivery, release, ...)    |

**Resources** — read-only, versioned assets your agent can load:

- `prompts://base-agent-constitution`
- `prompts://master-orchestrator`
- `prompts://roles/{role}` (e.g. `prompts://roles/technical-lead`)
- `prompts://policies/{policy}`
- `schemas://{schema}` (project, event, task-envelope, ...)
- `workflows://{workflow}` (delivery, change-control, release, incident)

**Prompts** — pre-assembled chat instructions:

- `act_as_role(role)` — instruct the host to act as a specialist agent
- `conduct_code_review` — run a governed code-review session

---

## 7. Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `No module named 'mcp'` | Install the extra: `python -m pip install ".[mcp]"` or run via `uv run --with "mcp[cli]"` |
| Server runs but tools missing | Restart the agent session; MCP tool lists are fetched at startup |
| Docker build slow | First build downloads the base image + `mcp` SDK; subsequent builds are cached |
| "unknown agent role" | Call `list_roles` first — roles come from `prompts/roles/*.md` at runtime |
| HTTP port already in use | `docker run -p 9000:8000 ...` and point clients at the new port |

---

## 8. Development

```bash
python -m pip install -e ".[mcp]"   # dev install incl. MCP
python -m unittest discover -s tests -v   # 48 tests (incl. MCP adapter)
python -m compileall -q src tests
```