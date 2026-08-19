# Install Software Agent

Software Agent's primary runtime is a TypeScript/Node.js terminal application. The Python package in this repository is optional compatibility support for existing MCP integrations.

> Copy only commands shown inside code blocks. Labels such as “Install the verified release” are documentation headings, not PowerShell commands. Do not copy the `PS C:\...>` prompt itself.

## Requirements

- Node.js 22.14 or newer; Node.js 24 LTS is recommended.
- npm, included with Node.js.
- Git.
- GitHub CLI (`gh`) only when opening a GitHub URL or `OWNER/REPO`; it is not needed for local folders.
- Windows Terminal, iTerm2, or another modern terminal for the best live UI.

Check the tools:

```powershell
node --version
npm --version
git --version
gh --version
```

For remote GitHub projects, connect once with `gh auth login`. You may skip both `gh` commands when you only open local folders.

## Install the verified release

The public GitHub release is available now:

```powershell
npm install -g "https://github.com/khajaaijaz26/software-agent/releases/download/v0.6.0/software-agent-0.6.0.tgz"
software-agent --version
software-agent setup
```

GitHub publishes the SHA-256 digest for `software-agent-0.6.0.tgz` on the release page so it can be checked independently after download.

## Global npm registry installation

After the package owner completes npm registry authentication:

```powershell
npm install -g software-agent
software-agent --version
software-agent setup
```

The package is intentionally one global command, similar to other terminal coding tools. The controller, terminal UI, worker runtime, provider adapters, SQLite store, prompts, schemas, policy engine, and approval service ship together. Cursor, Codex, Claude Code, OpenCode, and VS Code are not dependencies.

Confirm the standalone installation:

```powershell
software-agent doctor --json
```

Look for `"mode":"standalone"`, `"requiresEditor":false`, and `"requiresExternalCodingCli":false`. OpenAI or Anthropic is used only after you connect your own API key. GitHub CLI, Vercel CLI, and Supabase CLI are optional service connectors rather than core runtime dependencies.

## Install from this checkout

Clone the source once, then install its dependencies and create the development command:

```powershell
Set-Location $HOME
git clone https://github.com/khajaaijaz26/software-agent.git software-agent
Set-Location $HOME\software-agent
npm ci
npm run check
npm link
software-agent --version
```

If you already cloned the repository, skip `git clone` and enter its actual folder. `Set-Location` changes the current terminal folder. If PowerShell says the default path does not exist, verify it first:

```powershell
Test-Path $HOME\software-agent
Get-ChildItem $HOME
```

For source development without a global link:

```powershell
Set-Location $HOME\software-agent
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

Open a local project from any directory:

```powershell
software-agent open C:\path\to\your-project
```

Or create/reuse a local working checkout from GitHub:

```powershell
software-agent open https://github.com/OWNER/REPOSITORY
software-agent open OWNER/REPOSITORY --github
```

The default checkout folder is `$HOME\SoftwareAgentProjects\OWNER\REPOSITORY`. Use `--destination C:\path\to\folder` to choose another location. Existing destinations must be Git checkouts; Software Agent will not overwrite an unrelated folder.

If PowerShell already displays `PS C:\path\to\your-project>`, do not type another heading or prompt marker. Enter only the `software-agent start "..."` command.

On first use, Software Agent creates:

- `.software-agent/project.toml` for project, model, runtime, budget, and UI settings;
- `.software-agent/policy.toml` for filesystem, process, network, production, secret, and telemetry policy;
- `.software-agent/.gitignore` to exclude SQLite, WAL, artifacts, attachments, and local runtime data.

Preview initialization without writing:

```powershell
software-agent init --name sample-project --no-write --json
```

## Connect an OpenAI API key

The simplest interactive setup is inside the live Software Agent room. Launch `software-agent`, type `/setup`, choose OpenAI, press Enter, and paste the key into the masked box. The direct commands remain available:

```text
/api connect openai <model-id>
/api test openai
/model openai/<model-id>
```

On Windows this uses Windows Credential Manager. The key is sent to the credential-store process only through stdin, and only a `manager://` reference is saved. The complete Windows write/read/delete path is covered by tests. macOS uses Keychain; Linux uses Secret Service when `secret-tool` is available.

For CI and non-interactive shells, use an environment reference instead:

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

Interactive room commands:

```text
/api connect anthropic <model-id>
/api test anthropic
/model anthropic/<model-id>
```

Non-interactive alternative:

```powershell
$env:ANTHROPIC_API_KEY = "your-key"
software-agent providers add anthropic --model <model-id> --credential env://ANTHROPIC_API_KEY
software-agent providers test anthropic
software-agent models use anthropic/<model-id>
```

Do not pass a raw key to `--credential`; it is rejected. Raw keys are accepted only by the masked in-room setup and are immediately moved to the OS credential store. Software Agent does not use `cmdkey`, because that would expose secret material through command arguments.

## macOS and Linux

```bash
npm install -g "https://github.com/khajaaijaz26/software-agent/releases/download/v0.6.0/software-agent-0.6.0.tgz"
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

Detailed view displays the full 26-role specialist catalog. The Simple default shows only active or blocked specialists. The current bounded runtime activates at most three durable execution seats—an orchestrator, a relevant delivery specialist, and an independent reviewer—and leaves every unassigned role token-free.

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

The room opens in Simple view. You need only two controls:

- type normally and press Enter to send;
- type `/` to search commands.

Every follow-up becomes a runnable agent turn, carries bounded recent context, and returns the selected model's real final reply in `CONVERSATION`. The right side shows only specialists who are working or need attention. Type `/details` when you want all 26 roles, raw committed events, exact tokens, tool/file evidence, and advanced selection controls. Type `/simple` to return.

The guided first-run path is:

```text
/setup
Choose OpenAI or Anthropic
Paste the key into the masked box
Type your request and press Enter
```

The UI clearly calls out approval decisions in yellow. Opening `/approvals` shows the exact action and impact before you approve, deny, or request changes. Leaving the screen can keep the durable controller working, pause it, or cancel it.

Agent and event labels are deliberately literal:

| Label | Meaning |
| --- | --- |
| `READY` | Software Agent is connected and ready for a message. |
| `WORKING` | The team is executing the current request. |
| `YOUR DECISION IS NEEDED` | A guarded action is safely waiting for your review. |
| `FINISHED` | Current work is complete; type a follow-up to continue. |
| `WORKING NOW` | This agent currently has an executing turn. |
| `WAITING FOR WORK` | This named role has no assigned turn and consumes no model tokens. |
| `WAITING FOR INPUT` / `WAITING FOR HANDOFF` | A named dependency must arrive before the agent can continue. |
| `IDLE - NOT WORKING` | The session is present but is not executing; `Last:` describes historical activity. |
| `DONE` / `FAILED` | The agent is terminal. |
| `LIVE SCROLL` | The event panel automatically follows new committed events. |
| `SCROLL PAUSED` | Only the event view stopped following; agent execution is not paused. Press `Ctrl+F` or use `/follow` to resume live scrolling. |
| `YOU ›` | Your committed objective or follow-up message. |
| `✓` / `[REPLY]` | The selected model's actual final answer for that agent turn. |

Useful in-room slash commands:

| Command | Result |
| --- | --- |
| `/setup` | Guided OpenAI/Anthropic secure connection. |
| `/simple` | Return to the clean conversation-first screen. |
| `/details` | Open the complete multi-agent control room. |
| `/agents` | Focus the wall and report the 26 named roles. |
| `/status` | Summarize the run, working agents, approvals, and token mode. |
| `/api connect openai <model>` | Open the masked secure-key flow. |
| `/api test openai` | Verify the saved credential and provider model catalog. |
| `/model openai/<model>` | Change the project default for new turns. |
| `/tokens economy` | Use the 25% run allowance (`balanced` is 50%). |
| `/settings` | Show project, model, token, and provider settings. |
| `/target` | Select an active run, task, or execution seat for the next instruction. |
| `/clear` | Clear only the local chat/work view; durable history remains intact. |

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

These adapters currently discover status and produce governed mutation plans. Software Agent v0.6 does not silently execute remote pushes, deployments, or database migrations.

## Controller lifecycle

Normal CLI use requires no daemon setup. Software Agent discovers or starts a detached workspace-bound controller and communicates through authenticated local IPC.

For development, force an embedded controller:

```powershell
$env:SOFTWARE_AGENT_CONTROLLER_MODE = "embedded"
software-agent --project C:\path\to\project run --json "Test the embedded flow"
```

Or launch the packaged controller manually:

```powershell
node $HOME\software-agent\dist\controller.js --workspace C:\path\to\project
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
Set-Location $HOME\software-agent
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[mcp]"
python -m software_agent.mcp_server
```

The historical `agentic_company` import and executable remain deprecated aliases for existing consumers.

## Verify a source build

```powershell
Set-Location $HOME\software-agent
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
