# Compatibility and migration

## Runtime matrix

| Concern | Current TypeScript application | Python/MCP compatibility |
| --- | --- | --- |
| Distribution | npm package `software-agent` 0.3.x | Python package `software-agent-compat` 1.0.0 |
| Runtime | Node.js 22.14 or newer | Python 3.10 or newer |
| Primary command | `software-agent` | `software-agent-reference`, `software-agent-mcp` |
| Deprecated aliases | npm `agent-company` shim | `agentic-company`, `agentic-company-mcp`, and `agentic_company` import |
| Project state | `.software-agent/state.sqlite` plus artifacts | `.agentic_company` JSON/JSONL compatibility state |
| Current schemas | `software-agent.*` and `schemas/vnext/` | root schemas and Python dataclasses |
| Shared durable runs | No | No |

The TypeScript controller is the sole Software Agent controller. Python remains
a reference and MCP compatibility boundary; it does not share a run stream,
approval, mutation lease, or IPC protocol with TypeScript.

## Explicit legacy readers

Current code recognizes only bounded legacy inputs needed for cutover:

- `.agent-company/project.toml`, policy, and gitignore configuration;
- `agent-company.controller/v1` descriptor and `agent-company.controller-lock/v1` lock discovery;
- pre-runtime-v2 stored events without `software-agent.*` event types;
- selected `agent-company.*` artifact, attachment, and connector records, which normalize to current output; and
- deprecated npm, Python entrypoint, and Python import aliases.

New current records use `software-agent.*`. The explicit
[`legacy-controller-descriptor`](../schemas/vnext/legacy-controller-descriptor.schema.json)
and [`legacy-event`](../schemas/vnext/legacy-event.schema.json) schemas are
reader contracts, not current producer schemas.

## Project configuration migration

When `.software-agent/project.toml` is absent and a valid
`.agent-company/project.toml` exists, initialization or configuration loading
can perform a bounded migration:

1. Copy the old project, policy, and gitignore files into
   `.software-agent/migration-backup/agent-company-v1/`.
2. Write `.software-agent/project.toml` as `software-agent.project/v2` and
   increment `mapping_revision`.
3. Normalize the policy marker to `software-agent.policy/v2`.
4. Preserve or create the current gitignore.

This does not import `.agent-company/state.sqlite`, approvals, budget rows,
events, worker attempts, or artifact provenance. The new
`.software-agent/state.sqlite` is authoritative only for new work.

Before migration, stop both controllers and back up the complete legacy
directory. Do not copy approval tokens or mark new approvals as already
approved or consumed.

## Residual compatibility controller path

Primary `start`, `run`, `resume`, `pause`, and `cancel` flows now use dotted
runtime-v2 RPC through the live IPC-backed project room. Several inspection and
approval subcommands still consume the camelCase `ControllerSnapshot` and
approval methods. The compatibility run/worker path also remains callable by
older clients, so it is not merely a reader yet.

The project-room approval intent currently bridges to compatibility
`approve`/`deny` because runtime v2 has no dotted approval command. Removing the
compatibility producer path requires migrating that bridge, the remaining
inspection commands, and any external protocol-1 clients; renaming schemas
alone would break them.

## Mixed event-store behavior

Compatibility and runtime-v2 events can share the current SQLite event table.
Runtime-v2 projection ignores event types that do not start with
`software-agent.`, but unfiltered recent-event and history pages return stored
envelopes from both generations. The vNext snapshot and event-page schemas make
that union explicit rather than silently weakening the current event schema.

Approvals and command receipts remain bound to their originating operation and
stream. A compatibility approval must never be inferred to authorize a
runtime-v2 mutation.

## Contract policy

- Current producers emit `software-agent.*` unless they are part of the still-active compatibility controller/worker path described above.
- Legacy acceptance is isolated in named readers or migration functions and normalizes forward where implemented.
- Schemas with `additionalProperties: false` require a version change before adding unreserved fields.
- Enum removal, canonical-hash changes, mutation-fence changes, and exit-code reuse are breaking changes.
- Root Python schemas must not be silently redirected to vNext `$id` values.
- A future state importer must preserve raw input, validate its source version, generate a deterministic report, and never manufacture current approval authority.

## Backup boundary

A TypeScript backup needs a consistent `.software-agent/state.sqlite` snapshot
and its artifact tree. A Python backup needs its state JSON, JSONL events, and
artifact content together. Keep the configuration migration backup as audit
evidence until the cutover is accepted.

See [Backup and recovery](runbooks/backup-and-recovery.md) and
[Local IPC](protocols/local-ipc.md).
