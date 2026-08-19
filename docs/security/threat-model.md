# Threat model

## Scope

This model covers the local TypeScript v0.7 CLI, its project state, attachment
and artifact handling, model/tool boundaries, provider CLI adapters, the active
local IPC/controller boundary, child worker processes, and the Python MCP
compatibility server.

## Assets

- Human authority and approval decisions.
- Source code, project configuration, event history, budgets, and artifacts.
- Provider identities, tokens, session material, secrets, and production data.
- Operation hashes, approval bindings, evidence, and release provenance.
- Local machine integrity and terminal/operator trust.
- Microphone capture, voice transcripts, generated reply audio, and the
  operator's expectation that recording occurs only on request.

## Trust boundaries

1. Human/operator to CLI and TUI.
2. CLI to controller over an authenticated Unix socket or Windows named pipe.
3. Controller to SQLite and artifact filesystem.
4. Controller/tool gateway to workers and model providers.
5. Connector adapter to provider CLI and remote API.
6. Local attachment bytes to scanners, models, and tools.
7. MCP clients to the Python server, especially over network transports.
8. Local CLI voice adapter to the microphone, OpenAI audio APIs, temporary WAV,
   and operating-system playback command.

## Assumptions

- v0.7 runs under a trusted local user account on a non-compromised OS.
- The workspace and provider CLI binaries are selected by that user.
- OS filesystem permissions and provider authentication work as documented.
- A local administrator, debugger, malicious dependency, or compromised user
  account can read process/filesystem state and defeat local controls; those
  require platform defenses.

## Primary threats and controls

| Threat | Existing controls | Residual risk / required work |
| --- | --- | --- |
| Agent self-approves a mutation | Approval decisions require human actor; exact binding; signed short-lived authorization and atomic consume | Local code/files can be tampered with; trusted decision UX and event signing remain pending |
| Approval replay or substitution | Expiry, canonical operation/binding hashes, SQLite atomic single use | Clock rollback and database-owner tampering are not cryptographically prevented |
| Unknown or destructive remote action | Deny unknowns, A5 default denial, selected hard denials, v0.7 remote mutations are plans | Future executors need provider-side preconditions and reconciliation |
| Prompt injection in file/repo/provider output | Content treated as data; attachment heuristic scan; terminal sanitization | Heuristics are incomplete; model isolation and provenance-aware context needed |
| Secret exfiltration | Masked entry; Windows Credential Manager/macOS Keychain/Linux Secret Service; stdin-only Windows writes; unique rotation references; reduced child environment; redaction; reference boundary | A compromised local account/process can read credentials; environment-reference mode exposes plaintext to the CLI; provider egress policy remains operator-owned |
| Path traversal or symlink escape | Realpath/allowed roots; directory symlinks skipped; digest-derived artifact paths | TOCTOU is possible between path check and read; descriptor-relative handles would improve this |
| Malicious attachment | Size/count/type rules, EICAR marker, secret/PII checks, no implicit transfer | Not a full malware sandbox or DLP product; archives are not recursively inspected |
| Event deletion or rewrite | Application append API, optimistic stream versions, WAL/full sync | User controlling files can rewrite DB; signing/anchoring and backup verification pending |
| Concurrent overspend | Transactional micro-dollar reservations | Provider-reported delayed/unpriced costs need conservative reconciliation |
| CLI injection / terminal escape | Spawn without shell, fixed argument arrays, terminal sanitization | Provider CLI compromise or unsafe future argument construction remains possible |
| Local IPC impersonation | Workspace/user-bound descriptor, separate nonce, HMAC proof, derived endpoint, heartbeat freshness, bounded frames; POSIX owner/mode checks | Windows ACL and OS peer identity are not independently checked; compromise of the local account exposes nonce material |
| Malformed IPC frame | Four-byte length prefix, 1 MiB default cap, fatal UTF-8 decoding, zero/oversize rejection, exact RPC method/parameter checks | `JSON.parse` accepts duplicate keys; peers must emit unique canonical keys |
| Worker escape or result forgery | Separate process, reduced environment, no shell, limits, startup lease-expiry check, attempt/lease/task result binding | No OS sandbox/network isolation, lease heartbeat, retry, output signature, or full orphan recovery |
| Unexpected or lingering microphone capture | Recorder loads only after `Ctrl+R`/`/voice`; visible recording overlay; two-minute hard cap; Enter stops; Esc cancels; unmount cleanup; `--offline` rejects before microphone access | OS/device drivers and a compromised dependency remain trusted; no hardware capture indicator can be guaranteed |
| Voice transcript executes unintended work | Transcript returns to the editable composer and needs a second Enter; normal controller policy and approvals then apply | Speech recognition can be wrong; the operator must review text before submitting |
| Voice audio or secret retention | PCM and in-memory WAV are zeroed; secret lease is cleared; generated speech uses a private random temporary WAV removed after playback | Provider retention follows the operator's OpenAI account/settings; OS, swap, crash dumps, or privileged local processes may retain bytes |
| Wrong agent reply is spoken | Voice command receipt records its deterministic task ID; TUI accepts only a later completion/failure with that exact ID | A compromised controller/database can forge local state; signed events remain pending |
| MCP remote takeover | stdio default; external controls documented | HTTP bind needs TLS/auth/authz/rate limits; FastMCP configuration must be reviewed |
| Dependency or build compromise | Lockfile, type/lint/test/build checks | Provenance attestation, SBOM, signing, and dependency policy remain roadmap |

## Connector-specific abuse cases

### GitHub

- Push to a protected/default branch is escalated; protected force push is
  hard-denied by action construction.
- Merge, repository transfer/deletion, reviewer impersonation, and token scope
  require provider-side verification in a future executor.
- A read-only inventory can still expose private repository metadata; do not
  place raw inventory in public logs.

### Vercel

- Production deploy, promotion, rollback, environment changes, and deletion
  must be A4/A5 and bound to the exact project/deployment.
- Logs can contain secrets or customer data and need redaction/classification.
- v0.7 only probes and inventories, or emits remote mutation plans.

### Supabase

- Production reset/seed and production secret copying are hard-denied.
- Migrations need exact SQL artifact hashes, environment/project binding,
  rehearsal evidence, and post-apply verification before execution is added.
- Schema inspection may expose identifiers and policy metadata; treat it as
  internal unless explicitly classified otherwise.

## Failure strategy

Fail closed when binding, policy, schema, approval, artifact integrity, or
environment identity is uncertain. Do not translate provider timeout into
success. Once a remote executor exists, uncertain postcondition must enter
`NEEDS_RECONCILIATION`, perform read-only observation, and require a human when
truth cannot be safely established.

## Security test requirements

- Approval mismatch, expiry, replay, non-human decision, and concurrent consume.
- Canonical hashing stability and malformed JSON values.
- Path traversal, symlink, size/count, secret, EICAR, and prompt-injection cases.
- Unknown operation and every hard-denial branch.
- Connector timeout/output cap/environment reduction/terminal escape.
- Event command replay/conflict and stream revision races.
- Budget concurrent reservations and price reconciliation.
- IPC nonce proof, protocol mismatch, oversized/fragmented frames, RPC
  correlation/timeouts, stale descriptors, cleanup, and platform path rules.
- Worker expired/binding-mismatched leases, output/time limits, cancellation,
  malformed/multiple result lines, child failure, and restart/orphan cases.
- Voice opt-in start, maximum duration, too-short/cancel/abort cleanup, WAV
  bounds, secret erasure, provider response limits, transcript confirmation,
  exact-task reply correlation, and playback cleanup.

## Review triggers

Update this model before enabling a real remote mutation, production model
provider, networked controller, worker sandbox, new secret backend, new
attachment type/extractor, MCP exposure beyond localhost, or stable/production
marketing claim. Re-review the voice boundary before adding wake-word capture,
background recording, streaming partial transcripts, another speech provider,
or persistent audio history.
