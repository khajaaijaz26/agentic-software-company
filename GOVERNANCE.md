# Governance

## Purpose

This document defines how the Open-Source Agentic Software Company project is
governed: who holds authority, how decisions are made, and how changes are
reviewed. It mirrors the governance baseline of the master system prompt: human
authority at material gates, evidence before claims, and a one-source-of-truth
record.

## Roles

| Role | Authority |
|------|-----------|
| Maintainer | Merges pull requests, owns release decisions, resolves governance disputes |
| Reviewer | Approves or requests changes on pull requests; may not merge alone |
| Contributor | Opens issues and pull requests |
| User | Consumes the project; files issues |

## Decision-making

- **Day-to-day technical decisions** are made by maintainers on pull requests.
- **Material decisions** (architecture changes, prompt-version changes, new
  governance rules, license changes, security posture) require a written
  Architecture Decision Record (ADR) under `docs/adr/` and a review by at
  least two maintainers.
- **Silence is not consent.** A decision is not approved by a timeout.
- Any decision may be revisited with new evidence; superseded decisions are
  marked, not erased.

## Approval gates (repository-level)

| Gate | Example | Control |
|------|---------|---------|
| G1 | Trivial doc/test change | Reviewer approval |
| G2 | Non-trivial code or prompt change | Reviewer approval + CI green |
| G3 | Architecture or governance change | Two maintainers + ADR |
| G4 | Release, license, or security-policy change | Maintainer consensus + recorded decision |

## Releases

- Releases follow [semantic versioning](https://semver.org).
- Each release records the prompt-library version alongside the code version.
- Release notes live in [CHANGELOG.md](CHANGELOG.md).

## Conflict resolution

If a decision cannot be reached, a maintainer may call a governance review.
Escalation goes to the project owner (`khajaaijaz26`).

## Changes to this document

Changes to this governance document require a G4 decision and a recorded ADR.