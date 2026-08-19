# Terminal Platform Blueprint v0.2 traceability

This matrix records what the Software Agent v0.7 implementation actually provides against the broader source blueprint. “Partial” means a meaningful path exists but the complete stable-platform requirement does not.

## Terminal and controller

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| Globally installable TypeScript CLI | Implemented | `software-agent` package/bin, strict TypeScript, Node.js 22.14+ |
| Human/plain/JSON/NDJSON output | Implemented | CLI output envelopes and stable exit-code map; NDJSON event follow is polling, not server push |
| Responsive project-room TUI | Implemented | Chat-first Simple default, optional complete 26-role Detailed view, actual final replies, guided setup, direct prompting, slash commands, approvals, tokens, targeted instructions, reconnect/resync, read-only mode, plain fallback |
| Two-way Nova voice | Implemented bounded | Explicit `Ctrl+R`/`/voice`, two-minute in-memory capture, OpenAI transcription, editable confirmation, exact-task reply correlation, and generated speech; no wake word or partial live transcript |
| Durable local controller | Implemented | Detached discovery plus embedded test mode; one authoritative SQLite-backed controller per workspace |
| Authenticated local IPC | Implemented local | Four-byte framed JSON, Unix socket/Windows pipe only, private nonce and HMAC proof, frame limits, descriptors, heartbeat, cross-process start lock |
| Single-writer enforcement | Implemented application-level | Controller lock and mutation lease/fence; the owning OS user can still alter files directly |
| Durable event source and replay | Implemented | WAL, synchronous writes, expected stream versions, idempotent command receipts, global cursors, bounded history/poll pages |
| Push subscriptions | Not implemented | Long polling plus resynchronization is used in v0.7 |
| Very-large-run compaction/pagination | Partial | Event pages are bounded; full run projections still need compaction |

## Multi-agent runtime

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| Visible specialist collaboration | Implemented bounded | Full 26-role catalog is visible; the bounded runtime projects at most three durable active execution seats and labels every unallocated role `WAITING FOR WORK` |
| Task DAG and bounded parallelism | Implemented slice | Fixed five-task dependency graph; one workspace mutation at a time; `maxParallel` 1–3 |
| Assignments, turns, attempts, mailboxes, handoffs | Implemented | Persisted runtime-v2 events and projections |
| Pause/cancel/restart recovery | Implemented bounded | Active attempts are aborted/fenced and tasks can be recovered; automatic retry/backoff and full orphan adoption are absent |
| Targeted live instructions | Implemented | Every instruction creates a runnable conversation task; team auto-routing and explicit run/task/agent targets retain cursor, revision, command-ID, and mutation-lease binding |
| Continuous conversation | Implemented bounded | Prior user/assistant turns are carried into each model request with a 12-message and 24,000-character controller bound; final replies are committed events |
| Human questions/answers | Implemented runtime | Typed commands and persisted question/mailbox state; the primary TUI emphasizes instructions/approvals |
| Arbitrary agent delegation trees | Not implemented | The v0.7 graph and three execution-seat roles are controller-defined |
| OS sandbox for model/tool execution | Not implemented | Controller-owned model/tools; approved commands are separate bounded processes, not a hostile-code sandbox |

## Models, context, and tokens

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| Deterministic offline provider | Implemented | Built-in adapter for setup, testing, and replayable demos |
| Native OpenAI provider | Implemented | Responses API, streaming tool calls/results, usage, model discovery, continuation ID |
| Native Anthropic provider | Implemented | Messages API, streaming tool blocks/results, usage, model discovery |
| BYOK secret isolation | Implemented | Masked in-room setup, Windows Credential Manager/macOS Keychain/Linux Secret Service, `env://` automation references; values are never persisted or passed to controller/command children |
| Project and role model switching | Implemented | `models use`, project TOML routes, user defaults, immutable routing revision |
| One-use model grants | Implemented | Provider/model/run/task/agent/attempt/revision/token/expiry binding |
| Repository retrieval | Implemented bounded | File listing, token-efficient literal `search_code`, exact-revision text reads; ignored/generated/secret/binary/large paths excluded |
| Vector/embedding RAG | Not implemented | No semantic index or separate source-code upload is claimed |
| Token-saving modes | Implemented | Economy 25%, balanced 50% default, quality 100% |
| Per-agent token reservations and reconciliation | Implemented | SQLite ledger, exact allocations, provider usage normalization, conservative unknown usage, snapshot/TUI projection |
| Complete live pricing catalog | Partial | Provider cost is shown when known; unknown pricing/cost remains `UNKNOWN` |

## Tools, governance, and evidence

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| Workspace-contained file tools | Implemented | Path canonicalization, symlink/secret/generated exclusions, exact SHA-256 revisions, atomic writes, size/count limits |
| Shell-free verification commands | Implemented | Exact executable/argv, small allowlist, reduced environment, time/output/process-tree bounds |
| A0–A5 risk vocabulary | Implemented | Local tools and connector action classification |
| Exact expiring approvals | Implemented | Actor/action/resource/environment/artifact/operation hash binding |
| Human-only decisions and single-use consumption | Implemented | SQLite transactions; agent decisions are rejected |
| Live command approvals | Implemented | A3 packet/event before process spawn; command waits for decision and fails closed on deny/expiry/cancel/replay |
| Secret-in-command prevention | Implemented pattern guard | Likely credential arguments are denied; scanners are not complete DLP |
| Fenced result acceptance | Implemented | Run/task/turn/attempt/lease/revision/epoch must remain current |
| Independent review and evidence | Implemented slice | Reviewer/QA tasks and persisted evidence frames |
| Signed audit export | Not implemented | Append discipline is local; no cryptographic export/signing yet |

## Attachments, artifacts, and connected platforms

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| SHA-256 content-addressed artifacts | Implemented | Immutable objects/refs and integrity checks |
| Bounded attachment ingestion | Implemented | Allowed-root resolution, size/count/type, malware-test, secret, PII, and injection findings |
| Transfer consent | Implemented safe default | Ingestion records `transfer_count: 0`; no implicit upload authority |
| GitHub/Vercel/Supabase discovery | Implemented read-only | Provider-owned CLI probes and inventories |
| Normalized remote action plans | Implemented | A0–A5 policy and operation hashes |
| Remote mutation execution | Not implemented | Push, deployment, and database actions remain governed plans |
| Postcondition reconciliation | Not implemented | Required before remote mutation executors are enabled |

## Distribution and compatibility

| Blueprint capability | Status | Current evidence and boundary |
| --- | --- | --- |
| npm package contents | Implemented | CLI/controller bundles, assets, prompts, schemas, workflows, docs |
| Python/MCP compatibility | Compatibility | `software_agent` primary module plus deprecated historical aliases; separate state |
| Legacy project migration | Implemented config-only | Backup-first migration into `.software-agent`; run state is not imported |
| Automated backup/restore command | Not implemented | Safe manual/SQLite guidance exists |
| Plugin marketplace/SDK | Not implemented | Plugin API version is reserved metadata only |
| Telemetry | Safe default | Off; no telemetry subsystem |

## Next engineering order

1. Add provider-idempotent remote mutation plus receipt and postcondition reconciliation for one non-production connector.
2. Add bounded automatic retries, lease extension, orphan reconciliation, and stronger OS isolation.
3. Add run snapshot compaction/pagination and optional server-push subscriptions.
4. Add signed export/import, automated backup/migration, and an event upcaster registry.
5. Evaluate an optional local semantic index only if it materially improves retrieval over the lightweight bounded search path.
