# Software Agent architecture

## Status and authority boundaries

This document describes the Software Agent v0.7 local developer platform.

Several surfaces coexist and must not be treated as one contract:

| Surface | Implemented now | Current limitation |
| --- | --- | --- |
| Installed TypeScript CLI | `software-agent`, with a deprecated `agent-company` migration shim; primary lifecycle, provider, model, token, setup, inspection, and approval commands are active | Selected legacy inspection and connector-plan paths remain during migration |
| Controller runtime v2 | event-sourced three-session runtime, bounded parallel DAG, durable assignments/turns/attempts/handoffs, executable conversation turns, mutation fencing, and polling/history | Automatic retries and complete external-side-effect reconciliation remain future work |
| Project-room TUI | chat-first Simple view, optional complete 26-role Detailed view, guided setup, direct typing, actual final replies, authenticated live IPC source, targeted instructions, approvals, model/tool activity, evidence, tokens, and cost | Very large projections still need pagination/compaction beyond current bounded event pages |
| Nova voice | explicit push-to-talk capture, editable OpenAI transcript, confirmed command submission, correlated spoken reply, non-recording device diagnostics, and a local speaker test | Requires configured OpenAI plus a visible microphone input; no always-on wake word or partial streaming transcript |
| Model gateway | deterministic, native OpenAI Responses, and native Anthropic Messages adapters with tool continuations, routing, and one-use grants | Provider availability, price, or usage that cannot be verified remains `UNKNOWN` |
| Token budgets | durable 25%/50%/100% accounts, per-agent reservations/reconciliation, approved extensions, snapshot projection, and live room display | The full ceiling is fixed at 100,000 tokens per run in v0.7 |
| Python/MCP | `software_agent` compatibility package and deprecated `agentic_company` aliases | Separate state and orchestration; never a second TypeScript controller |

The schemas in [`schemas/vnext`](../../schemas/vnext) describe these contracts
separately. A schema's presence does not imply that every adapter between the
contracts exists.

## Component map

```text
                       human / automation
                               |
              +----------------+----------------+
              | software-agent CLI              |
              | plain / JSON / compatibility UI |
              +----------------+----------------+
                               |
                 authenticated framed local IPC
                 Unix socket / Windows named pipe
                               v
              +---------------------------------+
              | controller service              |
              | embedded or standalone daemon   |
              +---------+---------------+-------+
                        |               |
          +-------------+               +------------------+
          v                                                v
  SQLite event store                             runtime-v2 scheduler
  receipts, approvals, budgets                   sessions / turns / attempts
          |                                                |
          v                                                v
  snapshots + event pages                  controller-owned model/tool executor
                                                   |        |        |
                                                   v        v        v
                                                models   workspace  approved
                                                         tools      commands

  project-room UI <---- IPC source adapter ----> snapshot/events/commands
                         cursor + mutation lease

  microphone -- explicit push-to-talk --> local Nova adapter --> OpenAI audio APIs
                     editable transcript -- confirmed Enter --> UI command
  committed matching reply --> OpenAI speech --> private temporary WAV --> OS audio

  model gateway + token ledger <---- active integration ----> runtime/TUI
```

## Project and durable state

Current TypeScript projects use `.software-agent/project.toml`,
`.software-agent/policy.toml`, and `.software-agent/state.sqlite`. Project
configuration is `software-agent.project/v2`. Loading a legacy
`.agent-company/project.toml` can copy configuration into the current directory
with a read-only migration backup, but it does not import legacy run state or
approval authority.

The SQLite event store uses WAL, full synchronous writes, foreign keys, a busy
timeout, expected stream versions, and durable command receipts. The same
database is opened by one controller through the supported lifecycle. This is
application-level single-writer coordination; it does not prevent the owning
OS account from directly modifying local files.

The shared event table can contain both compatibility events such as
`run.created` and runtime-v2 events such as `software-agent.run.created`.
Runtime-v2 projection ignores non-`software-agent.*` events, but unfiltered
snapshot and history pages can return both. Current events carry metadata
`schema: software-agent.event/v2`, `correlationId`, and `causationId`. The
separate legacy-event schema exists only for already stored compatibility data.

## Local controller and IPC

The CLI normally ensures a detached standalone controller is available and
connects to it. Tests and deployments that set
`SOFTWARE_AGENT_CONTROLLER_MODE=embedded` can create an in-process controller
service for the command lifetime. Both paths use the socket or pipe: the CLI
does not directly call `LocalController` for controller-backed commands.
When the authenticated descriptor belongs to an older CLI build, the current
CLI requests graceful daemon shutdown, waits for that exact instance to exit,
and starts its matching controller before issuing application commands.

IPC uses four-byte unsigned big-endian length-prefixed UTF-8 JSON frames with a
1 MiB default frame limit. A descriptor and separate owner-private nonce file
bind the endpoint to a workspace, local user, controller instance, and protocol
range. HMAC-SHA-256 nonce possession authenticates a hello before RPC.

The current descriptor is `software-agent.controller/v2` with protocol range
1 through 2. Protocol 2 adds dotted runtime methods for snapshots, event
polling/history, mutation leases, run lifecycle, questions, instructions, and
daemon shutdown. CamelCase compatibility methods remain active because some
inspection and approval paths still consume them. The server currently accepts any registered method after
either negotiated version; protocol-to-method gating remains an unresolved
compatibility decision.

See [Local IPC](../protocols/local-ipc.md) for the exact envelopes and method
table.

## Runtime-v2 execution model

The v0.7 runtime builds an initial deterministic five-task DAG across exactly three
durable execution-seat roles:

- `master-orchestrator`;
- `software-engineer`; and
- `reviewer-qa`.

The operator surface separately projects the stable 26-role catalog. The
orchestrator seat is shown as Master Orchestrator, the delivery seat is mapped
to the objective-relevant named engineering specialist, and the review seat is
mapped to QA Strategist or Code Reviewer. Every other catalog role remains
visible as `WAITING FOR WORK` with no model allocation. The wall therefore
communicates availability without pretending that 26 provider calls are
running or spending tokens simultaneously.

A new run begins `PAUSED`. Its `maxParallel` is one through three. The scheduler
runs ready tasks concurrently up to that bound, never assigns two active tasks
to the same session, and permits only one workspace-mutating attempt at a time.
It persists assignments, turns, attempts, handoffs, questions, mailbox
messages, evidence, and state changes.

Every later project-room message creates a separate `conversation` task rather
than an inert mailbox note. A team-targeted message is routed without an extra
model call: change/build language selects Software Engineer, review/test
language selects Reviewer & QA, and other questions select Master
Orchestrator. Explicit run/task/agent targets remain available. The executor
receives the current prompt plus at most 12 recent user/assistant messages and
24,000 characters of prior conversation. The bound controls token growth and
is not advertised as unlimited memory.

Runtime-v2 run states are `PAUSED`, `RUNNING`, `PAUSING`, `RECOVERING`,
`SUCCEEDED`, `FAILED`, and `CANCELED`. Task states are `BLOCKED`, `READY`,
`RUNNING`, `PASSED`, `FAILED`, and `CANCELED`. The broader compatibility
controller state enums are not valid runtime-v2 run or task views.

Every mutating runtime-v2 run, question, or instruction command carries:

- `schema: software-agent.command/v2`;
- an idempotent `commandId`;
- actor, correlation, and causation identity;
- `expectedRunRevision` for optimistic concurrency;
- a UI attachment identity; and
- the matching controller mutation `leaseId` and fence.

The controller injects the local human actor for mutation-lease acquisition,
renewal, and release. The run command then proves the attachment/lease/fence
binding again. Authentication, optimistic concurrency, and mutation leases are
separate from domain approval.

## Attempt, tool, subprocess, and recovery boundaries

Runtime-v2 sends a strict `software-agent.step/v1` manifest to an injectable
step executor. The installed controller uses a controller-owned model/tool
executor; direct runtime tests can use the child-worker executor. The manifest
binds run, task revision, session, turn revision, attempt, lease, fencing epoch,
workspace revision, role, objective, interaction kind, optional current prompt,
bounded prior conversation, heartbeat cadence, and execution limits.
It never contains provider or tool credentials.

The executor emits strict `software-agent.step-frame/v1` heartbeat, activity,
intent, and completion frames. Model calls stay behind one-use grants and the
controller-side secret broker. Repository discovery, literal context search,
reads, and writes pass through `WorkspaceEnvironment`; writes require an exact
revision plus the active lease/fence. Verification commands require an exact
human approval, use no shell, receive a reduced environment, and run in bounded
child process trees. A completed frame is accepted only while its attempt,
lease, revisions, turn, and fencing epoch remain current; late results are
recorded and rejected.

On controller startup, active or leased attempts are fenced, their assignments
are released, running tasks return to `READY`, sessions return to `IDLE`, and a
recovering run is rescheduled. Pause and cancel abort child execution and
persist terminal/interrupted state.

Recovery is still bounded:

- a heartbeat records liveness but does not extend the fixed lease expiry;
- ordinary worker failure is terminal for that task; there is no retry/backoff policy;
- restart recovery fences logical attempts but does not enumerate or kill every possible orphan OS process;
- model/tool execution is controller-owned rather than isolated in a hostile-code sandbox;
- approved verification commands have process separation but no OS sandbox, container, or network namespace; and
- uncertain external postconditions do not yet have a complete reconciliation workflow.

Process separation, reduced environment, binding checks, and fencing are
meaningful controls, but they are not a hostile-code sandbox.

## Snapshots and event delivery

`software-agent.snapshot/v2` returns the global event cursor, project identity,
current mutation lease, all runtime-v2 runs, and up to 250 recent stored events.
`software-agent.events/v2` is used for both history and long polling.

Polling accepts a cursor, limit up to 250, and wait up to 30 seconds. If more
than 512 events or 512 KiB have accumulated behind the cursor, the response is
empty with `resyncRequired: true`; a client must load a new snapshot. History
scans the global sequence and applies an optional run filter after the scan, so
its cursor can advance over events from other streams.

There is no server-push subscription. The live-room IPC source turns snapshots
plus committed event pages into a contiguous UI projection and reloads an
authoritative snapshot when the server requests resynchronization.

## Project-room TUI contract

`apps/operator-console` contains a reducer-driven Ink project room with:

- plain fallback below 60 columns or 20 rows;
- narrow, two-card, and three-card layouts at 60, 90, and 120 columns;
- a default Simple view with conversation, one human-readable progress summary,
  approvals that need attention, and only active/blocked/recently finished roles;
- a Detailed view with the complete 26-role wall, raw committed events,
  approval detail, exact token/cost data, files, tools, and evidence;
- normal typing for prompts and `/` commands for provider, model, token,
  guided setup, simple/details switching, settings, status, target, search,
  follow, and local-view operations;
- `Ctrl+R` or `/voice` for explicit Nova recording, an editable transcript,
  a separately confirmed submission, and speech for the matching committed reply;
- team-targeted chat by default, clearly labeled user messages and final model
  replies, plus live model/tool/file activity while each turn runs;
- explicit composer targets and confirmation state;
- focus, search, follow, help, reconnect, resync, stale, error, empty, and read-only states; and
- `NO_COLOR`, ASCII, non-interactive text, and terminal-restoration behavior.

Its `ProjectRoomSource` has three required operations: load an authoritative
`software-agent.project-room/v1` projection, wait for the next committed update
after a cursor, and execute a typed UI intent. It can also expose the optional
local `VoiceAssistant` capability used only after explicit operator input.
Reducer state changes authority
only after a committed update.

`IpcProjectRoomSource` is wired into the primary `start`, `run`, `resume`,
`pause`, and `cancel` flows. It acquires a 15-second controller mutation lease,
renews it before expiry, falls back to `READ_ONLY` when another room owns the
lease, checks each intent's `expectedCursor` against a fresh snapshot, then
uses the selected run's current revision in the runtime command. It releases
the lease on leave or disposal. `objective.create` creates a paused runtime-v2
run and immediately resumes it. `instruction.submit` creates a schedulable
conversation task; a paused run is resumed only after the instruction receipt
commits. Because live work can advance the stream between keystroke and append,
chat submission alone may rebase and retry on a run-revision conflict; approval
and other mutations retain strict cursor matching. `session.leave` can
continue, pause, or cancel.

The adapter derives activity, evidence, provider/model, usage, cost, token
budgets, and approval panels from authoritative snapshots and recent events.
Missing provider data stays `UNKNOWN`. Runtime-v2 command execution creates
durable exact approval records; the current UI decision is carried over the
authenticated compatibility-named `approve`/`deny` RPC while the command wait
and single-use consumption remain controller-owned.

## Nova voice boundary

Voice is a local CLI/TUI capability, not an IPC authority channel. The
Picovoice recorder is loaded lazily only after `Ctrl+R` or `/voice`, captures
16-bit mono PCM into bounded memory, and stops after at most two minutes. The
CLI resolves the saved OpenAI credential outside controller IPC, creates a WAV
in memory, and sends it to the transcription endpoint. Captured PCM and the WAV
buffer are zeroed after transcription, cancellation, validation failure, or
abort.

The returned text fills the ordinary composer. It does not create a run or
instruction until the operator reviews it and presses Enter again. From that
point the normal cursor, revision, mutation-lease, scheduler, tool, and approval
rules apply. When a voice-created command commits, the UI records its exact
task identifier and speaks only that task's committed completion or failure;
concurrent background events cannot be selected as the answer.

Speech generation uses OpenAI `gpt-4o-mini-tts` with the `nova` voice. Its WAV
is written with a random name below an OS temporary directory solely because
native playback tools require a file, then unlinked after playback. Voice is
not always listening, does not implement a wake word, and does not provide
partial live transcription. Transcription and speech provider usage is
separate from the controller's run-token ledger. CLI `--offline` rejects the
capability before provider configuration, credential, or microphone access.

## Models and provider boundary

`ModelGateway` registers adapters and normalizes discovery, streaming frames,
tool calls, usage, completion, and failure behavior. Implemented adapters are:

- a deterministic local adapter;
- native OpenAI Responses API transport; and
- native Anthropic Messages API transport.

Provider credentials are resolved from explicit secret references by the
controller-side secret broker. The interactive source stores masked raw input
directly in Windows Credential Manager, macOS Keychain, or Linux Secret
Service before any controller RPC; configuration receives only the opaque
reference. Credential rotation uses a new unique entry, atomically updates
user/project configuration, and deletes the previous entry only after commit.
Capability catalogs use
`software-agent.model-catalog/v1`; unavailable capability, context, pricing, or
usage data stays `UNKNOWN` rather than being guessed.

Routing produces immutable `software-agent.model-route/v1` revisions using
run, next-run, role, project, then user precedence. Explicit changes increment
the revision. `ModelBroker` issues in-memory, expiring, one-use
`software-agent.model-grant/v1` grants bound to run, task, agent, attempt,
provider, model, route revision, and token limits.

The installed controller resolves the effective project/role route for every
step, issues a one-use broker grant, invokes the selected adapter, persists
model/tool activity, reconciles provider usage, and records evidence. OpenAI
tool continuations use `previous_response_id`; Anthropic uses normalized
assistant/tool history. The deterministic route remains the offline default.

## Token budgets

The SQLite budget ledger supports token modes `economy`, `balanced`, and
`quality`, which set a base ceiling to 25, 50, or 100 percent of a configured
full ceiling. It supports optional exact-total per-agent shares,
transactional reservations, provider-usage normalization, conservative
`UNKNOWN` reconciliation, release, reassignment, 80-percent warnings, and
single-use approved extensions.

An extension must equal exactly 25 percent of the full ceiling, remain within
the full ceiling, and be consumed before an approval expiry no more than 15
minutes away. These relational rules are enforced by code and are described,
but not all can be expressed in a single JSON Schema instance.

Every new run receives a 100,000-token full ceiling and the selected mode. The
controller snapshot carries account and per-agent allocation views, and the
project room renders actual spent/reserved status. Balanced mode is the default
50% ceiling; economy is 25% and quality is 100%.

## Approvals, connectors, attachments, and artifacts

The approval service still implements exact operation bindings, human
decisions, expiry, single-use consumption, and states from `PENDING` through
`INVALIDATED`. Connector plans normalize A0 through A5 risk classes and hard
deny selected destructive operations. Attachments are scanned before content
addressed artifact storage and never grant transfer authority.

Those facilities are active. Before an allowlisted process command runs, the
controller creates an exact A3 packet bound to the agent, run, command digest,
attempt authority, and expiry; persists a visible request event; waits for a
human decision; and atomically consumes approval once. Denied, expired,
canceled, already-consumed, or mismatched approvals fail closed. Connected
remote mutations remain plan-only pending receipt/reconciliation executors.

## Compatibility boundary

Current schemas and outputs use `software-agent.*`. Explicit legacy readers
remain for project configuration, controller descriptor/lock discovery, old
stored events, selected artifact/attachment/connector inputs, the deprecated
npm binary, and Python import/entrypoint aliases. They are migration boundaries,
not permission to emit new legacy contracts.

The compatibility controller and worker path remains callable, and current
inspection/approval commands still consume parts of its projection. Primary
run creation and lifecycle now use runtime v2. Removing the residual path
requires migrating those remaining commands and external clients. See
[Compatibility and migration](../compatibility.md).

## Contract index

The most important current schemas are:

- [controller descriptor](../../schemas/vnext/controller-descriptor.schema.json), [handshake](../../schemas/vnext/ipc-handshake.schema.json), [request](../../schemas/vnext/ipc-request.schema.json), and [response](../../schemas/vnext/ipc-response.schema.json);
- [runtime snapshot](../../schemas/vnext/snapshot.schema.json), [event page](../../schemas/vnext/events-page.schema.json), [run](../../schemas/vnext/run.schema.json), [task](../../schemas/vnext/task.schema.json), and [event](../../schemas/vnext/event.schema.json);
- [project-room projection](../../schemas/vnext/project-room.schema.json), [committed update](../../schemas/vnext/project-room-update.schema.json), and [UI intent](../../schemas/vnext/project-room-command.schema.json);
- [step manifest](../../schemas/vnext/step-manifest.schema.json) and [step frame](../../schemas/vnext/step-frame.schema.json);
- model catalog, descriptor, route, grant, request, frame, result, and usage schemas; and
- token budget configuration, account, allocation, reservation, usage, and extension schemas.

## References

- [Local IPC](../protocols/local-ipc.md)
- [Compatibility and migration](../compatibility.md)
- [Threat model](../security/threat-model.md)
- [Backup and recovery](../runbooks/backup-and-recovery.md)
- [Blueprint traceability](../blueprint-traceability.md)
