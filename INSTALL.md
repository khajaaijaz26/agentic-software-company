# Install Software Agent

Software Agent's primary runtime is a TypeScript/Node.js terminal application. The Python package in this repository is optional compatibility support for existing MCP integrations.

## Requirements

- Node.js 22.14 or newer; Node.js 24 LTS is recommended.
- npm, included with Node.js.
- Git.
- Windows Terminal, iTerm2, or another modern terminal for the best live UI.

Check the tools:

```powershell
node --version
npm --version
git --version
```

## Global npm installation

After v0.3 is published:

```powershell
npm install -g software-agent
software-agent --version
software-agent setup
```

The package is intentionally one global command, similar to other terminal coding tools. The controller, terminal UI, provider adapters, SQLite runtime, prompts, schemas, and compatibility assets ship together.

## Install from this checkout

Use these exact PowerShell steps for the repository already on this computer:

```powershell
Set-Location C:\Users\khaja\agentic-software-company
npm ci
npm run check
npm link
software-agent --version
```

`Set-Location` changes the current terminal folder. If PowerShell says the path does not exist, verify it first:

```powershell
Test-Path C:\Users\khaja\agentic-software-company
Get-ChildItem C:\Users\khaja
```

For source development without a global link:

```powershell
Set-Location C:\Users\khaja\agentic-software-company
npm run dev -- --version
npm run dev -- setup --json
```

Remove the development link later with:

```powershell
npm unlink --global software-agent
```

## Open a project

Change to the repository that Software Agent should edit, then launch it:

```powershell
Set-Location C:\path\to\your-project
software-agent
```

Or provide the first objective immediately:

```powershell
software-agent start "Fix the issue, add tests, and update the documentation"
```

On first use, Software Agent creates:

- `.software-agent/project.toml` for project, model, runtime, budget, and UI settings;
- `.software-agent/policy.toml` for filesystem, process, network, production, secret, and telemetry policy;
- `.software-agent/.gitignore` to exclude SQLite, WAL, artifacts, attachments, and local runtime data.

Preview initialization without writing:

```powershell
software-agent init --name sample-project --no-write --json
```

## Connect an OpenAI API key

Set the key in the current PowerShell session. Software Agent stores only the reference `env://OPENAI_API_KEY`, not the value.

```powershell
$env:OPENAI_API_KEY = "your-key"
software-agent providers add openai --model <model-id> --credential env://OPENAI_API_KEY
software-agent providers test openai
software-agent models use openai/<model-id>
```

Then run:

```powershell
software-agent start "Describe the software change"
```

## Connect an Anthropic API key

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
software-agent providers add anthropic --model <model-id> --credential env://ANTHROPIC_API_KEY
software-agent providers test anthropic
software-agent models use anthropic/<model-id>
```

Do not pass a raw key to `--credential`; it is rejected. On Windows, the built-in release supports `env://` references. It deliberately does not use `cmdkey` because that would expose secret material through command arguments. Secure-store references are supported where a safe backend is available.

## macOS and Linux

```bash
npm install -g software-agent
cd /path/to/your-project
export OPENAI_API_KEY="your-key"
software-agent providers add openai --model <model-id> --credential env://OPENAI_API_KEY
software-agent models use openai/<model-id>
software-agent start "Describe the software change"
```

Linux `keychain://` support uses Secret Service when `secret-tool` is installed. macOS can resolve existing Keychain entries. Environment references work consistently on all platforms.

## Select models by agent role

Set one project default:

```powershell
software-agent models use openai/<model-id>
```

Or route a specialist separately:

```powershell
software-agent models use openai/<coding-model-id> --role software-engineer
software-agent models use anthropic/<review-model-id> --role reviewer-qa
software-agent models list
```

Supported runtime roles are `master-orchestrator`, `software-engineer`, and `reviewer-qa`.

## Reduce token use

Balanced mode is the default and permits 50% of the full run allowance:

```powershell
software-agent tokens mode balanced
software-agent tokens status
```

Available modes:

- `economy`: 25% allowance;
- `balanced`: 50% allowance;
- `quality`: 100% allowance.

Override one run:

```powershell
software-agent run --budget economy "Make one focused fix"
```

## Use the terminal room

The live room supports three responsive layouts and a plain fallback. Common keys are displayed in its footer. Important interactions include:

- select an agent, event, approval, or token panel;
- compose an instruction and target a run, task, or agent;
- inspect an approval packet, then explicitly approve, deny, or request changes;
- leave while the durable controller continues, pause the run, or cancel it.

For CI or scripts:

```powershell
software-agent run --json "Run a bounded task"
software-agent runs list --json
software-agent events list --ndjson
software-agent doctor --json
```

If a headless run reaches a human approval, it emits `run.waiting-approval` and exits with code `4`. Review it from an interactive room or with `software-agent approvals list`.

## GitHub, Vercel, and Supabase discovery

Optional provider CLIs can be connected independently:

```powershell
gh auth login
vercel login
supabase login
software-agent integrations test github --json
software-agent integrations test vercel --json
software-agent integrations test supabase --json
```

These adapters currently discover status and produce governed mutation plans. Software Agent v0.3 does not silently execute remote pushes, deployments, or database migrations.

## Controller lifecycle

Normal CLI use requires no daemon setup. Software Agent discovers or starts a detached workspace-bound controller and communicates through authenticated local IPC.

For development, force an embedded controller:

```powershell
$env:SOFTWARE_AGENT_CONTROLLER_MODE = "embedded"
software-agent --project C:\path\to\project run --json "Test the embedded flow"
```

Or launch the packaged controller manually:

```powershell
node C:\Users\khaja\agentic-software-company\dist\controller.js --workspace C:\path\to\project
```

The protocol uses a Unix socket or Windows named pipe, a private nonce file, HMAC authentication, a one-megabyte frame limit, and workspace/user/controller identity binding. It never falls back to TCP.

## Data locations

Project state lives in `.software-agent/`. Platform provider configuration defaults to:

| Platform | Configuration | Runtime/state |
| --- | --- | --- |
| Windows | `%APPDATA%\SoftwareAgent` | `%LOCALAPPDATA%\SoftwareAgent` |
| macOS | `~/Library/Application Support/Software Agent/config` | `~/Library/Application Support/Software Agent` |
| Linux | `$XDG_CONFIG_HOME/software-agent` | XDG data/state/runtime paths |

Set `SOFTWARE_AGENT_HOME` to place platform directories below one custom root. The deprecated `AGENT_COMPANY_HOME` variable is read only for migration compatibility.

## Optional Python and MCP compatibility

This is separate from the TypeScript controller and does not share runs or state:

```powershell
Set-Location C:\Users\khaja\agentic-software-company
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[mcp]"
python -m software_agent.mcp_server
```

The historical `agentic_company` import and executable remain deprecated aliases for existing consumers.

## Verify a source build

```powershell
Set-Location C:\Users\khaja\agentic-software-company
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
python -m unittest discover -s tests -v
python -m compileall -q src tests
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `software-agent` is not recognized | Reopen the terminal after global installation, or run `npm link` in the source checkout. |
| `node:sqlite` is unavailable | Upgrade Node.js to 22.14+; Node.js 24 LTS is recommended. |
| `PROJECT_NOT_INITIALIZED` | Run `software-agent init` in the target repository. |
| `SECRET_UNAVAILABLE` | Set the referenced environment variable in the same terminal before launch. |
| `PROVIDER_DISABLED` | Run `software-agent providers enable <provider>`. |
| Exit code `4` | Inspect the exact approval in the project room or with `software-agent approvals list`. |
| Session is read-only | Another terminal owns the short mutation lease; use that terminal or close it cleanly. |
| Controller descriptor is stale | Run `software-agent doctor --json`; stop only the verified stale process, then retry. |
| SQLite is locked | Ensure only the supported controller owns the workspace. Never delete live WAL files. |
| UI is too small | Enlarge the terminal or use `--plain`. |

See [Security](SECURITY.md), [Architecture](docs/architecture/architecture.md), [CLI ABI](docs/protocols/cli-abi.md), and [backup/recovery](docs/runbooks/backup-and-recovery.md).
