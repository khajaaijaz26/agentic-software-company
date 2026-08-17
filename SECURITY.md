# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Email the maintainers at `khajaaijaz26@gmail.com` with:

- a description of the vulnerability and its impact;
- affected files/modules and versions;
- a minimal reproduction or proof of concept;
- any suggested mitigation.

You will receive an acknowledgement within 72 hours. We will work with you to
confirm the issue, develop a fix, and coordinate a disclosure date.

## Security posture

This project encodes security controls into the platform itself:

- **Deny by default** — the policy engine rejects unknown operations (see `src/agentic_company/policy_engine.py`).
- **Approval gating** — production/sensitive/irreversible actions require bound, short-lived approval tokens; silence is never approval.
- **Least privilege** — agents receive only scoped tools, paths, data, and budget.
- **Prompt-injection resistance** — untrusted content is treated as data and can never override policy (see `prompts/base-agent-constitution.md` §5).
- **Redaction** — secrets are redacted from audit logs and never placed in model context.
- **Path-traversal protection** — the artifact store rejects paths outside its root.

## Security-relevant areas

Review these first when auditing:

- `src/agentic_company/policy_engine.py` — operation classification and gate decisions.
- `src/agentic_company/approval_service.py` — token binding, expiry, single-use semantics.
- `src/agentic_company/tool_gateway.py` — authorization, redaction, audit of tool calls.
- `src/agentic_company/artifact_store.py` — path safety and content addressing.
- `prompts/base-agent-constitution.md` — the prompt-injection and memory rules.