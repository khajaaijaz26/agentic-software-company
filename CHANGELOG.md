# Changelog

All notable changes are documented here. The project uses semantic versioning
per distribution: the npm CLI and preserved Python compatibility package have
independent version lines.

## [Unreleased]

### Planned

- Persistent worker lease heartbeats/extensions, bounded retries, crash
  recovery, orphan reconciliation, and OS-level sandboxing.
- Approval-backed execution adapters and reconciliation for normalized remote connector actions.
- Server-push event subscriptions and very-large-run snapshot compaction.
- Signed export/import and an automated Python-state migration tool.

## [npm 0.5.0] - 2026-08-19

### Added

- Continuous project-room conversation: every submitted follow-up now creates
  a durable, schedulable agent task and produces an actual model reply.
- Bounded cross-turn conversation context with explicit user/assistant roles,
  specialist labels, and a 12-message / 24,000-character controller limit.
- Automatic team routing for ordinary chat to Master Orchestrator, Software
  Engineer, or Reviewer & QA, while `/target` still supports explicit routing.
- Clear `YOU` and `REPLY` entries beside live model, tool, file, token, and
  agent-status activity in the split terminal room.

### Changed

- Normal chat now targets the Software Agent team by default, so users can type
  and press Enter without first understanding internal session identifiers.
- Successful, failed, or canceled historical runs can accept a new
  conversational turn; stale unfinished work is superseded before scheduling.
- The newest assigned task is projected on each agent card, and superseded
  canceled work no longer distorts successful progress percentages.

### Fixed

- Targeted instructions are no longer inert mailbox records: they are consumed
  by the scheduler, passed to the selected native model with recent context,
  and committed as visible final responses.
- Paused runs preserve revision-safe command composition and are resumed by the
  project-room adapter only after the chat turn has committed.
- Chat submission rebases across concurrent live-work revisions, and a newly
  installed CLI replaces an older detached controller before opening a room.

## [npm 0.4.1] - 2026-08-19

### Added

- Pressing `/` now opens a complete searchable slash-command menu with the
  active project, model, token mode, and API connection status.
- The menu exposes all 25 implemented command forms, filters while typing,
  supports arrow-key browsing and Tab completion, and runs the selected
  command with Enter.

### Changed

- Slash-command syntax is ranked ahead of descriptive text so partial provider
  commands resolve predictably without hiding related settings.

## [npm 0.4.0] - 2026-08-19

### Added

- A wide split-screen project room with committed chat/file/tool activity on
  one half and a compact wall of all 26 named specialist roles on the other.
- Truthful role states: `WORKING NOW`, `WAITING FOR WORK`, dependency-blocked,
  done, and failed. Unassigned roles remain visible without model allocation or
  token consumption.
- Direct typing for prompts plus in-room slash commands for agents, status,
  settings, API connection/testing/removal, model selection, token mode,
  targets, search, follow, local view clearing, and help.
- `software-agent open` for existing local projects, full GitHub URLs, SSH
  URLs, and `OWNER/REPO` shorthand, with safe reuse of existing Git checkouts.
- Masked OpenAI and Anthropic key entry inside the terminal room with atomic
  provider rotation and rollback-safe project/user configuration updates.
- Native Windows Credential Manager writes, reads, and deletes through Win32
  credential APIs; secret bytes travel only over child-process stdin.

### Changed

- Normal printable input now begins a prompt immediately. Live-event follow is
  available through `Ctrl+F` or `/follow`, and leaving uses Escape or `Ctrl+C`.
- The room projects model/provider/token settings and filters lease heartbeat
  noise from the human work stream.
- GitHub and installation documentation now starts with copy-paste commands,
  explains local/GitHub project opening, documents slash commands, and clearly
  separates the 26-role catalog from the bounded active execution seats.

### Security

- Raw API keys are never rendered, written to project/provider configuration,
  committed to events, or sent over controller IPC. Secure-store references
  use unique rotation identifiers, and old credentials are deleted only after
  the new configuration commits.
- Windows credential scripts are UTF-16LE encoded for PowerShell, bind only
  validated opaque targets, zero native secret buffers, and are verified by a
  real disposable write/read/delete round trip.

## [npm 0.3.2] - 2026-08-19

### Added

- A compact terminal translation of the established Software Agent logo using
  the prompt, agent-node, and verified-check motifs from the vector mark.
- Explicit run progress with passed/total tasks, percentage, failures, and
  working/waiting/idle/done agent counts.
- Per-agent task progress plus plain-language `WORKING NOW`, waiting, done, and
  `IDLE - NOT WORKING` labels in wide, compact, and plain terminal layouts.
- A copy-paste-first GitHub setup guide, modern technology inventory, status
  legend, and evidence-based comparison with a typical single-agent CLI.

### Changed

- Inactive activity is labeled `Last` instead of `Now`, unknown active time no
  longer appears for idle sessions, and event follow is labeled `LIVE SCROLL`
  or `SCROLL PAUSED` to distinguish it from run pausing.
- Command acknowledgements now explain whether the scheduler is assigning a
  new objective, waiting for a schedulable instruction target, or resuming
  approval-blocked work.

## [npm 0.3.1] - 2026-08-19

### Fixed

- Windows now resolves installed npm PowerShell shims for connector CLIs
  without enabling command-string shell execution; arguments remain separate
  and are covered by an injection-safety test.
- Vercel authentication discovery now uses the direct `whoami` command with a
  provider-appropriate timeout instead of parsing the slower teams table.
- GitHub, Vercel, and Supabase discovery now all report their actual connected
  state when installed through their standard Windows command shims.

## [npm 0.3.0] - 2026-08-19

### Added

- Renamed the product, npm package, primary binary, state directories, current
  schemas, and Python compatibility entrypoint to **Software Agent**.
- A durable three-specialist runtime with Master Orchestrator, Software
  Engineer, and Reviewer & QA sessions; a parallel five-task DAG; assignments,
  turns, mailboxes, handoffs, instructions, evidence, attempt fencing, pause,
  cancel, restart recovery, and idempotent command receipts.
- A responsive live Ink project room backed by authenticated event polling,
  cursor resynchronization, renewable mutation control, targeted instructions,
  detailed model/tool activity, approvals, token usage, cost, and plain output.
- Native OpenAI Responses and Anthropic Messages adapters with streaming tool
  calls/results, provider continuations, bounded HTTP handling, BYOK secret
  references, role/project routing, and one-use model grants.
- Controller-owned repository tools for bounded discovery, token-efficient
  literal context search, exact-revision reads, atomic writes, and approved
  shell-free verification commands.
- Economy (25%), balanced (50%), and quality (100%) token modes with balanced
  as the default, durable per-agent reservations, provider reconciliation,
  extensions, warnings, and runtime/TUI projection.
- User commands for secure provider setup, connection tests, model switching,
  role routes, secret-reference inspection, token modes, token status, and a
  guided `software-agent setup` flow.
- Original Software Agent logo, developer hero, social preview, workflow
  diagram, provenance record, rewritten installation guide, and release docs.

### Security

- Every allowlisted process execution crosses an exact, expiring, visible A3
  approval boundary and consumes authorization atomically once.
- Model credentials remain in the controller, never in worker manifests or
  verification subprocess environments; raw keys are rejected from config.
- Command arguments matching credential patterns are denied before spawn.
- Local IPC adds a cross-process start lock, terminal failed handshakes, fatal
  UTF-8 parsing, stronger Windows pipe identity binding, and exact cleanup.

### Compatibility

- The deprecated `agent-company` binary, historical schema readers, and
  `agentic_company` Python imports remain only as explicit migration aliases.

## [npm 0.2.0] - 2026-08-18

### Added

- Strict TypeScript `@agent-company/cli` package targeting Node.js 22.13+.
- Commander-based CLI with human, plain, JSON, and NDJSON modes and documented
  machine exit codes.
- Local controller implementing a deterministic create/approve/resume delivery
  slice with canonical run and task states.
- Authenticated local controller IPC over Unix domain sockets or Windows named
  pipes, with workspace/user-bound discovery, a separate private nonce,
  HMAC-SHA-256 handshake proof, bounded four-byte big-endian length-framed JSON,
  heartbeat descriptors, request correlation/timeouts, and clean shutdown.
- Automatic one-shot controller service for ordinary CLI commands plus a
  standalone `dist/controller.js` entry for a longer-lived single writer.
- SQLite WAL event store with optimistic stream concurrency, command
  idempotency receipts, and deterministic replay.
- SQLite approval service with exact operation binding, expiry, explicit human
  decisions, and atomic single-use consumption.
- A0-A5 policy classes, hard denials, a schema-validated tool gateway, and
  normalized GitHub/Vercel/Supabase connector action plans.
- Provider-owned CLI discovery adapters for GitHub, Vercel, and Supabase.
- Atomic budget ledger, deterministic and OpenAI-compatible model gateway
  interfaces, and a secret-reference broker.
- Child-process worker supervision with attempt/lease manifests, expiry check,
  reduced environment, cancellation, wall-time/output bounds, exactly-one-line
  NDJSON results, and attempt/lease/task result binding.
- SHA-256 content-addressed artifact storage and attachment ingestion with path,
  size, malware-test, secret, PII, type, and prompt-injection checks.
- Lazy specialist activation from the 25-role registry, Ink dashboard, terminal
  sanitization/redaction utilities, and a new vector logo.
- Draft 2020-12 vNext JSON Schemas plus architecture, ABI, threat-model,
  compatibility, recovery, and blueprint traceability documentation.

### Security

- Remote mutations default to plans and approvals rather than direct execution.
- Production Supabase reset/seed and secret-copy operations, plus force push to
  protected branches, are hard-denied in the v0.2 action builder.
- Attachment ingestion never grants transfer permission and records
  `transfer_count: 0`.

### Compatibility

- Preserved the Python package, prompt library, YAML workflows, root JSON
  schemas, and MCP server. Their JSON/JSONL state remains separate from v0.2
  SQLite state.

## [Python 1.0.0] - 2026-08-17

- Initial Python reference implementation with governed prompt library, 25 role
  prompts, policies, envelope schemas, workflows, CLI, and MCP adapter.
- Apache-2.0 project governance, contribution, security, and attribution files.
