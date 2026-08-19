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
