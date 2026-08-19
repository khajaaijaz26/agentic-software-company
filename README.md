# Software Agent

<p align="center">
  <img src="assets/software-agent-logo.svg" alt="Software Agent logo" width="164" />
</p>

<p align="center">
  <strong>A visible team of AI software agents working together in your terminal.</strong>
</p>

<p align="center">
  Plan, implement, review, and verify a repository change while you watch each specialist work, inspect token use, send instructions, and approve exact actions.
</p>

<p align="center">
  <a href="https://github.com/khajaaijaz26/software-agent/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/khajaaijaz26/software-agent?color=5c6cff" /></a>
  <a href="https://github.com/khajaaijaz26/software-agent/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/khajaaijaz26/software-agent/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-20c997" /></a>
  <a href="INSTALL.md"><img alt="Node 22.14+" src="https://img.shields.io/badge/Node.js-22.14%2B-339933" /></a>
</p>

![Three coordinated Software Agent workstreams connected through a local controller and human approval checkpoint](docs/images/software-agent-hero.png)

Software Agent is a standalone, local-first coding platform—not a plugin for Cursor, Codex, Claude Code, or another editor. Launch one command, type naturally or talk to **Nova**, and let its bundled controller coordinate the relevant specialists. The calm default screen shows only the conversation, current progress, and people who need your attention; `/details` reveals the full 26-role control room. Runs, approvals, usage, and evidence are recorded in SQLite so work survives terminal disconnects and controller restarts.

## Install and run

Requirements: Node.js 22.14 or newer, npm, and Git. Node.js 24 LTS is recommended. GitHub URL checkout also requires the [GitHub CLI](https://cli.github.com/) (`gh`); local folders do not.

> **Copy only commands inside the code blocks.** Do not type headings such as “Install Software Agent,” and do not copy the `PS C:\...>` prompt shown by PowerShell.

### Windows PowerShell — three steps

1. Install and verify the current release:

   ```powershell
   npm install -g "https://github.com/khajaaijaz26/software-agent/releases/download/v0.7.0/software-agent-0.7.0.tgz"
   software-agent --version
   ```

2. Enter the repository you want the agents to edit:

   ```powershell
   Set-Location C:\path\to\your-project
   ```

3. Open Software Agent:

   ```powershell
   software-agent
   ```

If the terminal already shows `PS C:\path\to\your-project>`, run only step 3. The first launch creates private `.software-agent/` state and opens the simple chat screen. Type `/setup` once to connect your AI, then type requests normally and press Enter.

You can also open a local folder or create/reuse a GitHub working checkout directly:

```powershell
software-agent open C:\path\to\your-project
software-agent open https://github.com/OWNER/REPOSITORY
software-agent open OWNER/REPOSITORY --github
```

GitHub repositories are edited through a normal local Git checkout, so every file change remains reviewable with standard Git tools. Run `gh auth login` once before opening a remote repository; private repositories use that GitHub CLI authentication.

### macOS or Linux

```bash
npm install -g "https://github.com/khajaaijaz26/software-agent/releases/download/v0.7.0/software-agent-0.7.0.tgz"
cd /path/to/your-project
software-agent
```

The verified GitHub release works now; GitHub publishes its SHA-256 digest on the release page. The shorter `npm install -g software-agent` command becomes available after the package owner completes npm registry authentication. Contributors can use the [source installation steps](INSTALL.md#install-from-this-checkout).

### Runs independently

Software Agent does not launch, automate, or depend on Cursor, Codex, Claude Code, OpenCode, VS Code, or another coding assistant. The npm package includes its own CLI, terminal UI, authenticated local controller, worker runtime, SQLite event store, prompts, schemas, provider adapters, policy engine, and approval service. OpenAI or Anthropic is contacted only when you connect that provider with your own key. GitHub CLI, Vercel CLI, and Supabase CLI are optional connectors for their respective services.

Verify this on any installation:

```powershell
software-agent doctor --json
```

The `runtime` result reports `mode: "standalone"`, `requiresEditor: false`, and `requiresExternalCodingCli: false`.

### Connect a real AI model

Without a configured provider, the deterministic offline adapter demonstrates orchestration and finishes quickly. For real repository work, open `software-agent` and type `/setup` **inside the Software Agent chat box**. Choose OpenAI or Anthropic with the arrow keys, press Enter, and paste the key into the masked field. The complete searchable command menu still opens whenever you type `/`:

```text
/setup
/api connect openai <model-id>
/api connect anthropic <model-id>
/api test openai
/model openai/<model-id>
/tokens balanced
/settings
```

The key-entry box is masked. On Windows the key is written through stdin to Windows Credential Manager; macOS uses Keychain and Linux uses Secret Service when available. Only a `manager://` or `keychain://` reference is saved in configuration. The raw key is never rendered, logged, committed, sent over controller IPC, or written to the repository.

For automation, environment references remain available:

```powershell
$env:OPENAI_API_KEY = "your-key"
software-agent providers add openai --model <model-id> --credential env://OPENAI_API_KEY
software-agent providers test openai
software-agent models use openai/<model-id>
software-agent start "Implement the requested change and verify it"
```

Anthropic Messages is supported in the same way with `ANTHROPIC_API_KEY` and `anthropic/<model-id>`. Run `software-agent setup` at any time for the non-interactive secure setup sequence.

### Talk to Nova

Nova is the built-in push-to-talk voice assistant. Voice uses your configured OpenAI credential even when Anthropic is selected for the coding agents.

It uses the official [Picovoice PvRecorder Node SDK](https://picovoice.ai/docs/quick-start/pvrecorder-nodejs/), [OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), and [OpenAI speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create).

1. Open Software Agent and connect OpenAI once with `/setup`.
2. Press `Ctrl+R` or type `/voice` **inside the project room**.
3. Speak for up to two minutes, then press Enter.
4. Review or edit the transcript that appears in the normal composer.
5. Press Enter again to submit it for planning and execution.
6. Nova reads the matching committed agent reply aloud.

Try saying: “Nova, tell me what every active agent is working on.” Use Tab or `/target` before recording when you want one specific agent to answer.

The microphone is never always listening: it opens only after `Ctrl+R` or `/voice`. Captured PCM stays in memory, is capped at two minutes, and is erased after transcription or cancellation. Speech is sent to OpenAI for transcription, and replies use an AI-generated voice. The transcript is never executed until you confirm it with the second Enter. Nova fails closed under `--offline` before reading a credential or opening the microphone.

### Chat naturally, then keep going

Inside the project room, just type a message and press Enter. You do not need a special `prompt` command:

```text
YOU › Fix the login test and explain the cause.
Software Engineer › read_file completed for src/auth.ts
Software Engineer › write_file completed for src/auth.ts
Software Engineer › ✓ The null-session branch is fixed and the focused test passes.

YOU › Now add a regression test for that edge case.
Software Engineer › ✓ Added the regression case and verified the focused suite.
```

The first message creates the project objective. Every later message becomes a durable, schedulable conversation turn—not merely a saved note. The controller keeps a bounded recent conversation history, routes team-targeted messages to the Master Orchestrator, Software Engineer, or Reviewer & QA, shows model/tool/file activity while the turn runs, and then prints the model's actual final reply. Short continuations such as `continue` stay with the recent specialist when appropriate.

Normal chat targets the **Software Agent team** so routing stays simple. Press Tab while composing, or use `/target`, only when you want to address one specific active agent or task. A real conversational answer requires a connected OpenAI or Anthropic model; `deterministic/local` is an offline orchestration demo rather than a general-purpose AI assistant.

## The project room

The terminal UI starts in Simple view so it feels like a familiar coding-agent chat. Type normally to start; press `/` for commands, `/setup` to connect AI, or `/details` when you want the complete control room:

```text
❯_ ●─●─● ✓ SOFTWARE AGENT                    project @ main | WORKING
READY | You are in control | runs independently in this terminal
WORKING · Fix the login error                 2/5 steps finished
┌─ CONVERSATION ──────────────────────┬─ TEAM ────────────────────────────────┐
│ YOU › Fix the login error           │ ● Backend Engineer                   │
│ Backend Engineer › Thinking...      │   Working on: repair authentication  │
│ Backend Engineer › Tool finished    │ ! Security Engineer                  │
│ Backend Engineer › ✓ Login fixed    │   Waiting for your approval          │
│                                     │ 2 working · 24 ready                 │
└─────────────────────────────────────┴────────────────────────────────────────┘
AI connected · openai | BALANCED | 1 approval | /details for more
YOU › Type your next message here
Ctrl+R talk to Nova · / commands · Enter send
```

Simple view keeps the conversation and next action obvious. Detailed view retains the complete 26-role wall, committed event history, current file/tool activity, exact token usage, approval packets, reconnect/resync diagnostics, and read-only fallback when another terminal owns the mutation lease.

| Screen label | Exact meaning |
| --- | --- |
| `READY` | The controller is connected and you can type a message. |
| `WORKING` | At least one specialist is executing the current request. |
| `YOUR DECISION IS NEEDED` | Work is safely waiting for you to inspect an exact approval. |
| `FINISHED` | All current steps completed; type another message to continue. |
| `WORKING NOW` | The agent currently owns an executing turn. |
| `WAITING FOR WORK` | The named role is available but has no assigned execution seat; it is not using model tokens. |
| `WAITING FOR INPUT/HANDOFF` | The agent cannot continue until the named dependency arrives. |
| `IDLE - NOT WORKING` | The session exists, but no turn is executing. The card shows its last activity. |
| `DONE` / `FAILED` | The agent reached a terminal state. |
| `LIVE SCROLL` | New committed events automatically remain visible. |
| `SCROLL PAUSED` | Only automatic event scrolling is paused; the run and agents are unaffected. Press `Ctrl+F` or use `/follow` to resume. |

## Modern technology stack

Software Agent uses a current, widely adopted stack while keeping the installed CLI local and self-contained:

| Layer | Technologies | Purpose |
| --- | --- | --- |
| Primary runtime | TypeScript 5.9, Node.js 22/24, modern ESM | Type-safe controller, CLI, workers, and adapters compiled to JavaScript. |
| Terminal experience | React 19, Ink 6, ANSI-safe responsive rendering | Live multi-panel project room with keyboard control and plain-output fallback. |
| Commands and validation | Commander 14, Zod 4, JSON Schema Draft 2020-12 | Stable CLI grammar and versioned machine contracts. |
| Durable coordination | Built-in SQLite, WAL, event sourcing, idempotency receipts | Restartable runs, tasks, leases, approvals, evidence, and replay. |
| AI providers | OpenAI Responses API, Anthropic Messages API, BYOK secret references | Native model calls, tool results, streaming normalization, usage, and cost. |
| Voice interface | Picovoice PvRecorder, OpenAI transcription and speech APIs, native OS WAV playback | Explicit push-to-talk, editable transcripts, and Nova's spoken committed replies. |
| Repository retrieval | Bounded file listing, literal code search, exact SHA-256 reads | RAG-style selective context without forcing a heavy vector database into every install. |
| Security boundary | OS credential stores, HMAC-SHA-256 local IPC, named pipes/Unix sockets, lease fencing | Keeps raw API keys out of repositories, worker processes, and controller messages. |
| Compatibility | Python 3.10–3.14 and MCP compatibility package | Preserves existing Python/MCP integrations without making Python the primary runtime. |
| Quality and delivery | Vitest, ESLint, tsup, GitHub Actions | Tests, static checks, builds, package smoke tests, and Windows/macOS/Linux verification. |

## Why it is different

| Capability | What Software Agent does |
| --- | --- |
| Visible collaboration | Defaults to calm conversation plus active/blocked specialists; `/details` expands to all 26 roles, files, tools, tokens, cost, and events. |
| Continuous conversation | Turns every follow-up into an executable, durable agent turn with bounded history and a clearly labeled final reply. |
| Two-way voice with Nova | Records only on explicit `Ctrl+R`/`/voice`, returns an editable transcript, waits for confirmation, and speaks only the correlated committed reply. |
| Honest specialization | Exposes all 26 named roles while activating only the bounded orchestrator, delivery specialist, and reviewer seats needed by the current run. |
| Safe coding tools | Provides bounded file discovery, token-efficient code search, exact-revision reads, atomic writes, and shell-free verification commands. |
| Human authority | Turns process execution and connected mutations into exact, expiring, single-use approval packets. Silence and `--yes` are never approval. |
| BYOK models | Supports native OpenAI Responses and Anthropic Messages adapters; keys are resolved controller-side from `env://` or supported secure-store references. |
| Lower token use | Defaults to balanced mode at 50% of the full run allowance, with per-agent allocation, reservation, reconciliation, and live usage views. |
| Durable operation | Persists events, command receipts, leases, attempts, budgets, approvals, and evidence in a local SQLite WAL database. |
| Automation-ready | Offers stable human, plain, JSON, and NDJSON outputs plus documented exit codes and JSON Schemas. |

### Compared with a typical single-agent terminal CLI

This is an architectural comparison, not a claim that every other tool behaves identically:

| Area | Typical single-agent CLI | Software Agent |
| --- | --- | --- |
| Work display | One conversation or activity stream | Chat-first Simple view plus an optional complete 26-role control room and live progress |
| Voice workflow | Often absent or separate from execution | Built-in push-to-talk, editable transcript, explicit send, targeted agent questions, and spoken committed replies |
| Coordination | One model handles planning, coding, and review sequentially | Durable orchestrator, relevant delivery specialist, and independent reviewer seats with handoffs |
| Restart behavior | Terminal session often owns transient state | Controller and SQLite event log survive UI disconnects and support deterministic replay |
| Tool authority | Broad confirmation or process-level permission | Exact actor/action/resource/environment binding, expiry, and single-use approval consumption |
| Context use | Large prompt dumps can repeatedly resend repository text | Search-first retrieval and exact file reads feed only relevant context into each turn |
| Model choice | One provider or model for the whole session | OpenAI or Anthropic defaults plus per-role routing and controller-owned BYOK secrets |
| Token controls | Provider totals shown after calls | 25%/50%/100% modes, reservations, per-agent attribution, reconciliation, warnings, and cost |
| Automation | Human-formatted output is the main interface | Human TUI plus versioned JSON, NDJSON, schemas, exit codes, and idempotent commands |

## Governed agent workflow

![Prompt enters the controller, fans out to three agents, crosses exact approval and tool boundaries, and returns verified evidence](docs/images/software-agent-workflow.svg)

1. Your objective is committed as a run with a five-task dependency graph.
2. The Master Orchestrator analyzes scope and creates implementation context.
3. The Software Engineer retrieves only relevant repository context, edits through fenced exact-revision writes, and requests approval before running a process.
4. Reviewer & QA works independently and can run in parallel where the graph permits.
5. Handoffs, tool activity, model usage, token reservations, and evidence become replayable events.
6. Follow-up chat messages create new routed turns and carry a bounded recent conversation instead of becoming inert mailbox notes.
7. The controller accepts a result only when its run, task, turn, attempt, lease, revision, and fencing epoch still match.

## Spend fewer tokens deliberately

Software Agent does not promise a fixed percentage reduction in provider billing. It enforces a smaller run allowance and makes usage visible so the team must retrieve and act on relevant context.

| Mode | Effective run allowance | Recommended use |
| --- | ---: | --- |
| `economy` | 25% | Small fixes, focused reviews, constrained budgets |
| `balanced` | 50% | Default for everyday development |
| `quality` | 100% | Large or reasoning-heavy changes |

```bash
software-agent tokens mode balanced
software-agent tokens status
software-agent run --budget economy "Fix the parser regression and add one test"
```

The 50% default is a hard allowance, not a marketing estimate. Provider-reported input, output, cached-input, reasoning, total tokens, and cost are normalized; unknown usage remains `UNKNOWN` rather than being guessed.

## Model and role routing

```bash
software-agent providers list
software-agent models list
software-agent models use openai/<model-id>
software-agent models use anthropic/<model-id> --role reviewer-qa
software-agent secrets list
```

Coding-model calls happen in the controller. Nova audio calls happen in the local CLI so microphone bytes never cross controller IPC. Worker manifests and subprocess environments never contain model credentials. Software Agent uses official API protocols; it does not scrape human-formatted output or reuse private login sessions from Codex, Claude Code, or OpenCode. Optional CLI bridges can be added later only behind explicit, machine-readable capability contracts.

## Approval and tool policy

Risk classes communicate authority:

| Class | Meaning | Default |
| --- | --- | --- |
| A0 | Observe | Allowed inside policy |
| A1 | Local safe operation | Allowed with workspace and lease checks |
| A2 | Workspace mutation | Fenced, exact-revision operation |
| A3 | Process execution | Exact human approval |
| A4 | External write | Exact human approval |
| A5 | Destructive or irreversible | Denied by default; selected operations are hard-denied |

Approvals bind the requesting actor, connector, action, resource, environment, artifact digest, and canonical operation hash. They expire and can be consumed only once. Command arguments that resemble credentials are denied before process creation.

Read [SECURITY.md](SECURITY.md) and the [threat model](docs/security/threat-model.md) before enabling real providers or connected mutations.

## Architecture

```text
Ink terminal room / JSON automation
                │ authenticated framed IPC
                ▼
       local controller daemon
       ├─ durable scheduler + sessions + handoffs
       ├─ model broker ─ OpenAI / Anthropic / deterministic
       ├─ token ledger + secret broker
       ├─ approval + policy boundary
       ├─ workspace tools + disposable attempts
       └─ SQLite WAL events / receipts / evidence
```

Important implementation details:

- Four-byte length-framed JSON over a Unix socket or Windows named pipe; no TCP fallback.
- Workspace/user/instance-bound descriptor, private nonce, HMAC proof, frame limits, and correlated typed RPC.
- Detached controller discovery with cross-process start locking and stale-process recovery.
- Idempotent commands, optimistic revisions, mutation leases, attempt fencing, cancellation, bounded output, and restart replay.
- Draft 2020-12 contracts in [`schemas/vnext`](schemas/vnext).

See [Architecture](docs/architecture/architecture.md), [local IPC](docs/protocols/local-ipc.md), and [blueprint traceability](docs/blueprint-traceability.md).

## Useful commands

```bash
software-agent                         # open or create the local project room
software-agent open C:\path\to\repo  # open a local project
software-agent open OWNER/REPO --github # check out/open a GitHub project
software-agent start "your objective" # create a run and watch it live
software-agent run --json "objective" # headless/machine flow
software-agent runs list
software-agent tasks graph
software-agent approvals list
software-agent tokens status
software-agent changes diff
software-agent doctor --json
software-agent commands model
```

Inside the live room, press `Ctrl+R` or type `/voice` to talk to Nova. Slash commands are entered in the Software Agent composer—not in PowerShell.

GitHub, Vercel, and Supabase adapters currently provide read-only discovery and governed mutation plans. Remote mutation execution remains intentionally disabled until its receipt/reconciliation path is complete.

## What “context retrieval” means here

The coding runtime has bounded repository listing, literal code search, and exact file reads. It uses those tools to select relevant context instead of injecting an entire repository into every prompt. This release does not claim embedding/vector RAG, a language server, or a semantic code index. Those can be optional modules later without making the base install heavy or sending source code to a separate indexing service.

## Install from source and contribute

```bash
git clone https://github.com/khajaaijaz26/software-agent.git
cd software-agent
npm ci
npm run check
npm link
software-agent --version
```

The primary platform is TypeScript. A separately named Python/MCP compatibility runtime remains for existing integrations and does not share controller state. See [INSTALL.md](INSTALL.md), [Compatibility](docs/compatibility.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [GOVERNANCE.md](GOVERNANCE.md).

## Current boundaries

Software Agent v0.7 is a local developer preview. Its catalog contains 26 named roles (shown on demand in Detailed view), while this release intentionally activates at most three durable execution seats per run to bound cost and preserve independent review. Conversation history is deliberately bounded rather than an unlimited memory. Nova is push-to-talk rather than an always-listening wake-word assistant, requires an OpenAI connection, and transcribes only after recording stops. The platform has no OS-level sandbox or Windows named-pipe peer-SID verification, no vector RAG index, no signed event export, and no enabled remote mutation executor. Treat model output, transcripts, and repository content as untrusted. Review changes and approvals before relying on results.

Visual assets are original to this repository; generation and composition details are recorded in [asset provenance](docs/assets/PROVENANCE.md).

Licensed under [Apache-2.0](LICENSE).
