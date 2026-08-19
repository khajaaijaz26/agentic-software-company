# Runbook: backup and recovery

## Scope

This runbook protects local v0.4 project state. It does not replace provider
backups or reconcile a remote mutation. Project state consists of:

- `.software-agent/state.sqlite` and possible `-wal`/`-shm` sidecars;
- `.software-agent/project.toml` and `policy.toml`;
- `.software-agent/artifacts/`; and
- a record of CLI version and source revision.

All of these can contain confidential metadata. Store backups encrypted and
restrict access to the project owner.

Controller locks, descriptors, nonce files, and sockets/pipes live in the platform
runtime directory, not `.software-agent/`. They are ephemeral authentication
material and must not be restored from backup. A newly started controller
creates a fresh instance and nonce.

## Preferred consistent backup

1. Stop all Software Agent CLI/controller/worker processes for the project.
2. Confirm no process has the database open.
3. Copy the entire `.software-agent/` directory to a new versioned backup
   directory on the same trust boundary.
4. Record SHA-256 hashes for the copied files and the output of
   `software-agent version --json`.
5. Reopen the original and run `software-agent state check --json`.

Stopping writers makes copying the database plus WAL sidecars consistent.
Never delete `state.sqlite-wal` or `state.sqlite-shm` to make a backup appear
clean.

For live systems, use SQLite's supported backup API or `VACUUM INTO` through a
purpose-built, tested administrative command. The v0.4 CLI does not provide
that command, so do not improvise SQL against a live project.

## Restore

1. Stop all processes that could open the target project.
2. Preserve the damaged/current `.software-agent/` directory as forensic input;
   do not overwrite the only copy.
3. Restore the complete backup into a new test workspace first.
4. Restrict permissions to the intended local user.
5. Run `software-agent --project <test-workspace> state check --json` and inspect
   runs, approvals, event counts, and artifact presence.
6. Only after validation, select the restored workspace for continued work.
7. Record the restore time, operator, backup identity, and any events known to
   be missing.

Do not mark an in-flight operation successful merely because the local backup
contains an intent event. Observe remote providers read-only and reconcile
external truth separately.

## Integrity checks

- SQLite opens and reports WAL mode.
- Event sequences and per-stream versions are monotonic with no duplicates.
- Command receipts refer to valid first/last sequences.
- Approval bindings and hashes parse; no consumed approval is reused.
- Every referenced artifact file exists and verifies against its SHA-256 name.
- Project mapping in TOML matches the expected workspace.

The current `state check` command reports only basic counts; deeper checks need
manual inspection or future tooling. Treat an unexplained mismatch as
`NEEDS_RECONCILIATION`.

## Corruption or uncertain external effects

1. Stop mutation attempts.
2. Make a read-only forensic copy of database, WAL/SHM, artifacts, logs, CLI
   version, and sanitized provider observations.
3. Restore the last verified backup into an isolated workspace.
4. Compare append-only local events with read-only GitHub/Vercel/Supabase state.
5. Do not replay a command unless its idempotency key, exact target, and remote
   postcondition are established.
6. Ask a human to choose repair, accept external state, compensate, or abandon.
7. Record the decision as a new event/report; do not edit history in place.

## Python compatibility backup

Stop MCP/CLI processes and copy `.agentic_company/state.json`,
`.agentic_company/events.jsonl`, and associated artifacts together. Validate
that every JSON line parses. Keep Python and vNext backups separate; neither
runtime can restore the other's format.

## Backup testing

At least once per release that changes persistence:

1. create a run with an approval and artifact;
2. take a backup;
3. complete more work after the backup;
4. restore to a different workspace;
5. confirm the restored state stops exactly at the backup point; and
6. verify every restored artifact digest.
