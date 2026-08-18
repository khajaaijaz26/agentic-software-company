# Governance

## Purpose

This document defines project authority and change control for Agent Company
CLI. It applies to both the npm terminal-platform preview and the preserved
Python/MCP compatibility runtime. It does not grant an AI agent authority to
make repository, release, production, legal, or financial decisions.

The project owner and current maintainer is `khajaaijaz26`.

## Project roles

| Role | Authority |
| --- | --- |
| Maintainer | Triage, merge, release, security coordination, and final project decisions |
| Reviewer | Review a proposed change and record approve/request-changes evidence |
| Contributor | Propose issues, patches, schemas, tests, and documentation |
| User | Operate the software and report defects or requirements |

Runtime specialist-agent names are software roles, not project-governance
roles. They have no merge, release, or approval authority merely because a
prompt assigns them a title.

## Decision principles

- Evidence precedes claims.
- Silence is not consent.
- The smallest reversible change is preferred when it meets the requirement.
- Human decisions are attributable and preserved; superseded records are not
  erased.
- Changes crossing a trust boundary receive independent review.
- Compatibility breaks and residual risk are documented before release.

## Change classes

| Class | Examples | Minimum review |
| --- | --- | --- |
| C0 | Typo, non-normative clarification | Maintainer or reviewer |
| C1 | Reversible implementation or test change | One reviewer and required CI |
| C2 | Contract/schema, persistence, approval, policy, connector, or compatibility change | One independent reviewer, tests, migration/compatibility note |
| C3 | Security posture, remote execution, production support, architecture boundary, or data handling | ADR, threat-model review, two maintainers when available |
| C4 | Release, license, governance, ownership, or coordinated disclosure | Project owner plus recorded decision |

When the project has only one active maintainer, required independent review
cannot be silently waived. The release record must identify the missing review
and the reason, and high-risk functionality should remain disabled by default.

## Architecture decisions

Durable decisions live under `docs/adr/` and include context, decision,
alternatives, consequences, owner, date, status, and a revisit trigger. A later
ADR supersedes rather than rewrites the historical decision.

## Schema and CLI governance

- Schemas under `schemas/vnext/` and the exit-code/output rules in
  `docs/protocols/cli-abi.md` are public preview contracts.
- A compatible change may add optional fields or new event/output `type`
  values. It must not change existing field meaning.
- Removing a field, changing an enum, reusing an exit code, or altering
  canonical hashing requires a versioned schema/ABI and a migration note.
- Root `schemas/*.json` remain Python compatibility contracts until a recorded
  migration retires them.

## Releases

- npm and Python distributions are versioned independently while both runtimes
  remain supported.
- A release must record the source commit, distribution version, schema and
  plugin/API versions, test evidence, known limitations, and migration steps.
- Release artifacts should be reproducible and inspected before publication.
- Production/stable labels require all mandatory architecture controls for that
  claim; a preview may not be relabeled stable to satisfy a schedule.

## Security and conflicts

Security reports follow [SECURITY.md](SECURITY.md), not public issue triage.
Reviewers disclose material conflicts of interest. If consensus is unavailable,
the project owner decides and records the rationale. License, governance, and
ownership changes remain C4 decisions.

## Amending this document

Changes require a C4 decision. The pull request or release record must state
what authority changed and why.
