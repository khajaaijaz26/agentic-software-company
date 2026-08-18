# Changelog

All notable changes are documented here. The project uses semantic versioning
per distribution: the npm CLI and preserved Python compatibility package have
independent version lines during the v0.2 transition.

## [Unreleased]

### Planned

- Persistent worker lease heartbeats/extensions, bounded retries, crash
  recovery, orphan reconciliation, and OS-level sandboxing.
- Approval-backed execution adapters for normalized connector actions.
- Live event subscriptions and a fully interactive operator console.
- Signed export/import and an automated Python-state migration tool.

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
