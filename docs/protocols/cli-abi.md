# CLI application binary interface

## Version

This document defines the preview ABI for `software-agent` 0.3.x. The CLI
reports code version `0.3.1`, schema version `1`, and plugin API version `1`.
Preview contracts can grow compatibly; incompatible changes require a new
schema identifier and release note.

## Invocation

```text
software-agent [global-options] <command> [command-options]
```

Selection options include `--project <path>`, `--run <id>`, `--workspace`, and
`--profile`. Output options are `--json`, `--ndjson`, `--plain`, and
`--no-color`. Automation should add `--non-interactive` and should never rely
on a prompt being answered implicitly.

In v0.3, `--project` and `--run` are active selectors. `--workspace`,
`--profile`, `--config`, `--timeout`, custom `--log-level`/`--trace-id`,
non-default `--unicode`, and init strategy overrides are reserved ABI names and fail with
`CAPABILITY_UNAVAILABLE` instead of being silently ignored. Standard
redaction is always active; another `--redact` value is rejected. Run-scoped
`--budget economy|balanced|quality` and `--max-parallel 1..3` are active.

Global options may appear before or after a subcommand because Commander
resolves inherited options. Scripts should still place them before the command
for readability.

## Standard output and standard error

With `--json` or `--ndjson`, result and error envelopes are written to stdout.
Diagnostic text must not be mixed into a JSON value. Without a machine flag,
results go to stdout and errors go to stderr.

`--json` currently emits one envelope per command. `--ndjson` uses the same
envelope shape per line; commands that later stream events may emit multiple
lines. Parsers must accept unknown `type` values and ignore unknown optional
data fields, but must reject an unknown top-level `schema` unless explicitly
configured for forward compatibility.

Success envelope:

```json
{
  "schema": "software-agent.output/v1",
  "type": "run.created",
  "data": {}
}
```

Error envelope:

```json
{
  "schema": "software-agent.error/v1",
  "type": "error",
  "data": {
    "code": "APPROVAL_REQUIRED",
    "message": "approval is required",
    "next": "software-agent approvals list"
  }
}
```

Machine strings are UTF-8 JSON. Human output is not a stable parsing surface.
Terminal control characters are sanitized from provider and error strings.

## Exit codes

| Code | Symbol | Meaning |
| ---: | --- | --- |
| 0 | `SUCCESS` | Command completed as requested |
| 2 | `USAGE` | Invalid CLI syntax, selection, or missing initialization |
| 3 | `POLICY_DENIED` | Policy or attachment safety denied the request |
| 4 | `APPROVAL_REQUIRED` | A valid plan exists but needs an explicit human approval |
| 5 | `AUTH_REQUIRED` | Provider or local authentication is required |
| 6 | `CAPABILITY_UNAVAILABLE` | Requested capability is unavailable/offline |
| 7 | `TRANSIENT_FAILURE` | Retry may succeed without changing the request |
| 8 | `ACTION_FAILED` | The attempted action failed |
| 9 | `PARTIAL` | Some bounded work completed, some did not |
| 10 | `RECONCILIATION_REQUIRED` | External/local truth cannot be safely inferred |
| 11 | `CANCELED` | User or policy canceled the operation |

Exit code `1` is intentionally not part of the public mapping. Shells or
launchers may use it before the CLI runtime gains control. Never treat any
nonzero code as approval.

## Error-code rules

`data.code` is an uppercase underscore identifier and is more specific than the
process exit category. Existing error codes keep their meaning within schema
v1. A `next` command is advisory and must not be executed without the caller's
normal authority checks.

## Determinism and identifiers

Identifiers such as `run_`, `evt_`, `apr_`, `act_`, and `op_` are opaque.
Callers must not derive authority, ordering, or timestamps from them. Event
ordering uses integer `sequence` and per-stream `streamVersion`.

Operation hashes are lowercase SHA-256 values. Connector action hashes carry a
`sha256:` prefix; contract/approval binding digests are 64 lowercase hex
characters. Callers must preserve the exact representation used by the
relevant schema.

## Approval automation

An automation may list and display approvals, but only an attributable human
decision may transition a pending approval to `APPROVED`, `DENIED`, or
`CHANGES_REQUESTED`. `--yes` is not an approval flag. Scripts should:

1. create or request the action;
2. accept exit `4` as a safe waiting state;
3. display the exact binding, target, environment, artifact, expiry, and hash;
4. record a human decision; and
5. resume with the returned run/approval identifiers.

## Compatibility tests

Release checks should snapshot:

- `software-agent version --json`;
- representative success and error envelopes;
- all exit-code branches;
- `schemas/vnext/output.schema.json`; and
- parseability of one envelope per supported `type`.
