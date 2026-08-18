# Installation and integration

This repository contains two intentionally separate runtimes:

1. `@agent-company/cli` v0.2, the primary TypeScript terminal-platform preview.
2. `agentic-company` 1.x, the preserved Python prompt-pack and MCP compatibility
   runtime.

Install only the runtime you need, or install both for development. They do not
share durable state.

## TypeScript CLI requirements

- Node.js 22.13 or newer. The TypeScript runtime uses Node's built-in SQLite
  API, so older Node releases are unsupported.
- npm, supplied with Node.js.
- Git for repository inspection.
- Optional provider CLIs for read-only connector discovery: GitHub CLI (`gh`),
  Vercel CLI (`vercel`), and Supabase CLI (`supabase`). Each provider owns its
  own login session; Agent Company does not copy their credentials.

Node 22.13 supports the required API but labels `node:sqlite` experimental and
may write its upstream `ExperimentalWarning` to stderr. JSON/NDJSON envelopes
remain isolated on stdout. A current Node 22 maintenance release or Node 24 is
recommended for quieter operation; the warning does not indicate state loss.

Check versions:

```bash
node --version
npm --version
git --version
```

## Install the TypeScript CLI from this repository

```bash
git clone https://github.com/khajaaijaz26/agentic-software-company.git
cd agentic-software-company
npm install
npm run check
npm link
agent-company version
```

`npm link` makes the local build available as `agent-company`. If you do not
want a global link, use the development entry point from the repository root:

```bash
npm run dev -- version --json
```

To remove the development link later:

```bash
npm unlink --global @agent-company/cli
```

## Initialize a workspace

Agent Company writes project-local files beneath `.agent-company/`. Runtime
SQLite databases, WAL files, artifacts, and local overrides are ignored by the
generated `.agent-company/.gitignore`.

```bash
mkdir sample-project
cd sample-project
git init
agent-company init --name sample-project
```

Preview without writing:

```bash
agent-company init --name sample-project --no-write --json
```

Initialization creates:

- `.agent-company/project.toml`: mapping, runtime, budget, and UI defaults.
- `.agent-company/policy.toml`: local filesystem, shell, network, production,
  secret, and telemetry defaults.
- `.agent-company/.gitignore`: excludes local state and sensitive runtime data.

Do not commit `.agent-company/state.sqlite`, its `-wal`/`-shm` files, or the
artifact directory.

## Run the governed vertical slice

```bash
agent-company run --json "Design and verify a bounded change"
```

The command creates a run and plan approval, prints their identifiers, and
exits `4` (`APPROVAL_REQUIRED`). Review before approving:

```bash
agent-company approvals list --json
agent-company tasks graph <run-id> --json
agent-company approvals approve <approval-id> --reason "Scope and tasks reviewed"
agent-company resume <run-id> --json
agent-company events list <run-id> --ndjson
```

The current deterministic adapter makes this flow repeatable and offline. It
does not provide production-quality model reasoning.

## Output modes

- Default: human-readable; an Ink dashboard is used when appropriate.
- `--plain`: no cursor-control UI; suitable for logs and narrow terminals.
- `--json`: one machine-readable envelope.
- `--ndjson`: line-delimited machine envelopes.
- `--no-color`: disables ANSI color.
- `--non-interactive`: promises that the command will not prompt.
- `--offline`: blocks provider/network discovery.

For automation, always inspect both the envelope and process exit code. See
[docs/protocols/cli-abi.md](docs/protocols/cli-abi.md).

## Attachments

Only paths under the selected workspace are accepted by default:

```bash
agent-company attachments scan ./request.md --json
agent-company attachments add ./request.md --json
agent-company attachments add-dir ./specs --json
agent-company run --file ./request.md --json
```

The receipt records scan findings and stores content by SHA-256. Ingestion does
not upload the file or authorize future transfer. Files containing likely
secrets are blocked; an EICAR test signature is quarantined.

## Provider CLI connections

Authenticate directly with each provider's official CLI, outside Agent
Company. Examples:

```bash
gh auth login
vercel login
supabase login
```

Then run non-mutating probes:

```bash
agent-company integrations catalog --json
agent-company integrations test github --json
agent-company integrations test vercel --json
agent-company integrations test supabase --json
agent-company integrations list github --json
```

Credentials stay with the provider CLI. The connector runner passes a reduced
environment, bounds execution time and captured output, avoids a shell, and
sanitizes terminal-control characters.

Connected mutation commands are planning surfaces in v0.2:

```bash
agent-company repo push --plan --json
agent-company pr open --json
agent-company deploy preview --json
agent-company deploy production --json
agent-company database plan --environment staging --json
```

These emit `agent-company.connector-action/v1` records and, for gated classes,
exit `4`. They do not execute the remote mutation. Production database reset
or seed, production secret copying, and protected-branch force pushes are
hard-denied in the connector action builder.

## Platform data locations

Project state always lives under the selected project's `.agent-company/`
directory. `agent-company config path --json` also reports platform-level
paths:

| Platform | Default base behavior |
| --- | --- |
| Windows | `%APPDATA%\AgentCompany` and `%LOCALAPPDATA%\AgentCompany` |
| macOS | `~/Library/Application Support/AgentCompany` |
| Linux/Unix | XDG config/data/state/cache/runtime directories |

Set `AGENT_COMPANY_HOME` to place all platform-level directories below a
single absolute root. This does not move project-local state.

## Controller lifecycle and local IPC

Controller-backed CLI commands always communicate through authenticated local
IPC. The client first looks for a fresh workspace-bound descriptor. If no
controller can be used, the CLI starts a one-shot local service in the same
process, connects over a Unix socket or Windows named pipe, performs the RPC,
then closes that service. This requires no setup.

For a controller that stays available across commands, build and launch the
standalone entry in a separate terminal:

```bash
node dist/controller.js --workspace /absolute/path/to/sample-project
```

Source-development equivalent:

```bash
npx tsx apps/controller-daemon/src/index.ts --workspace /absolute/path/to/sample-project
```

Stop it with `Ctrl+C`/`SIGTERM`. Optional flags are `--runtime`,
`--build-version`, and `--heartbeat-ms`. The controller prints a descriptor
summary at startup; it never prints the authentication nonce. The npm package
currently installs only the `agent-company` binary, so invoke the standalone
controller through `node dist/controller.js`.

The protocol uses a workspace/user-bound descriptor, a separate owner-private
nonce file, HMAC-SHA-256 proof, and four-byte big-endian length-framed JSON
(1 MiB default maximum). See
[docs/protocols/local-ipc.md](docs/protocols/local-ipc.md). On Windows, keep the
runtime directory protected by the account's normal ACLs; v0.2 does not
independently verify an owner-only Windows ACL.

Approved runs execute deterministic tasks in separate child Node processes.
Each attempt has a lease ID/expiry, wall-time limit, output limit, reduced
environment, and bound result. This is process separation, not an OS sandbox:
workers have the workspace as their current directory, and lease heartbeats,
automatic retries, and full orphan recovery are not implemented.

## Python and MCP compatibility runtime

Python 3.10 or newer is required. The core package uses the standard library;
the MCP server needs the optional `mcp` extra.

```bash
python -m venv .venv
```

Activate the environment:

```bash
# macOS/Linux
source .venv/bin/activate

# PowerShell
.venv\Scripts\Activate.ps1
```

Install and verify:

```bash
python -m pip install -e ".[mcp]"
python -m unittest discover -s tests -v
python -m compileall -q src tests
```

Run the MCP server locally over stdio:

```bash
python -m agentic_company.mcp_server
```

Or use HTTP transports for a deliberately configured remote environment:

```bash
python -m agentic_company.mcp_server --transport sse --mount-path /mcp
python -m agentic_company.mcp_server --transport streamable-http --mount-path /mcp
```

The HTTP defaults bind broadly. Put authentication, TLS, request limits, and
network access controls in front of the server before exposing it beyond a
trusted development network. The authenticated local TypeScript IPC protocol
is used by the v0.2 CLI but is unrelated to MCP.

Ready-made MCP client examples live under `configs/`. Resolve all relative
paths from the repository checkout, or install the Python console script and
configure the client to invoke `agentic-company-mcp`.

## Development checks

TypeScript:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run check
npm pack --dry-run
```

Python compatibility:

```bash
python -m unittest discover -s tests -v
python -m compileall -q src tests
python -m build
```

Schema parse check (PowerShell):

```powershell
Get-ChildItem schemas\vnext\*.json | ForEach-Object {
  Get-Content $_.FullName -Raw | ConvertFrom-Json | Out-Null
}
```

## Backup and migration

Close all Agent Company processes before copying a project SQLite database.
Copy the database together with any `-wal` and `-shm` sidecars, or use SQLite's
online backup mechanism. Artifacts are a separate content-addressed tree and
must be backed up with the database. Full guidance is in
[docs/runbooks/backup-and-recovery.md](docs/runbooks/backup-and-recovery.md).

There is no automatic migration from Python JSON/JSONL state to TypeScript
SQLite in v0.2. Keep the original state until a migration tool is released.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `node:sqlite` unavailable | Upgrade to Node.js 22.13 or newer. |
| Node 22.13 prints an SQLite `ExperimentalWarning` | Expected from that Node release; use a current Node 22 maintenance release or Node 24. |
| `PROJECT_NOT_INITIALIZED` | Run `agent-company init` in the selected workspace. |
| Exit code `4` | Review `approvals list`, approve/deny explicitly, then resume. |
| Provider reports `AUTH_REQUIRED` | Log in with that provider's own CLI, then rerun the probe. |
| Provider reports `UNAVAILABLE` | Install the relevant CLI and ensure it is on `PATH`. |
| Attachment is `BLOCKED` | Inspect findings; remove secrets/unsafe content rather than bypassing the scan. |
| `DESCRIPTOR_STALE` | Stop any unhealthy standalone controller, verify the PID, then retry; do not delete another user's runtime files. |
| `HANDSHAKE_REJECTED` | Stop the suspected controller, preserve diagnostics, and restart it so the descriptor/nonce pair is recreated. |
| `CONTROLLER_ALREADY_RUNNING` | Use the existing controller or stop it cleanly with `Ctrl+C`; do not start a second writer. |
| `WORKER_TIMEOUT` / `WORKER_OUTPUT_LIMIT` | Narrow the task or configured limits; the current worker supervisor does not retry automatically. |
| SQLite reports a lock | Ensure no abandoned process is holding the project, then retry; do not delete WAL files while a process is open. |
| `No module named mcp` | Install the Python extra with `python -m pip install -e ".[mcp]"`. |
| MCP tools appear stale | Restart the MCP client session so it re-discovers capabilities. |

Run `agent-company doctor --json` for non-mutating diagnostics. When reporting
a bug, include the CLI version, Node version, OS, sanitized error envelope,
and reproduction steps. Never include tokens, `.env` files, provider configs,
or unredacted project databases.
