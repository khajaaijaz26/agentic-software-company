# Default Project Policy

> Version 1.0 — 17 August 2026
> Owner: Maintainers / Delivery Owner
> Scope: Applies to every project in the agentic software company unless a stricter project-specific policy is approved.

## 1. Purpose

This policy sets the baseline authorization, approval, and evidence rules that the orchestrator and specialist agents apply to every project. It implements the operating principles of the architecture (evidence before claims, least privilege, human authority at material gates, reversible steps, independent verification, traceable handoffs).

## 2. Identity and scope

- Every project has a `project_id`, a `request_id`, and a `correlation_id`.
- Every artifact, request, decision, and handoff includes a project ID, owner, status, version, and timestamp.
- The original client request is preserved as an immutable artifact.

## 3. Approval gates (baseline)

| Gate | Examples | Required control |
|------|----------|------------------|
| G0 — autonomous read | Read allowed project files, inspect test logs, search approved public documentation | Policy check and audit only |
| G1 — reversible workspace change | Create a branch, edit scoped files, run local tests, build a preview | Scoped permission, automatic checks, later review |
| G2 — shared or external non-production effect | Open a pull request, post to a project channel, create a staging resource, use a paid API above threshold | Named project approval or pre-approved standing policy |
| G3 — production or sensitive effect | Deploy, migrate production data, rotate a credential, access restricted customer data, send customer communication | Explicit authorized human approval for the exact action |
| G4 — irreversible, legal, financial, or high-impact effect | Delete production data, incur a material charge, sign/accept terms, change access control, publish a release, security disclosure | Dual approval where appropriate, recovery plan, strong identity verification |

Rules:

- A rejection cannot be converted into approval by rephrasing the same request.
- Silence, a timeout, a general project approval, or approval of a different artifact is not approval for a gated action.
- Approval tokens are bound to actor, action, resource, environment, task revision, and artifact hash; they are signed, short-lived, and single-use.

## 4. Tool permissions

- Deny by default.
- Separate read, write, execute, publish, and administer permissions.
- Scope filesystem access to explicit roots; normalize paths to prevent traversal.
- Scope network access to approved domains, methods, ports, and response sizes.
- Broker secrets by opaque handles; never insert raw secrets into model context, logs, or artifacts.
- Use short-lived credentials bound to the run and environment.
- Re-authorize at execution time; permission at planning time is not sufficient.

## 5. Evidence and verification

- Every acceptance criterion receives `pass`, `fail`, `not_applicable`, or `blocked` status with evidence.
- Independent review is required for material outputs; the author is never the sole approver.
- A test may be claimed passed only with recorded output.
- Deployment may be claimed successful only after deployment and post-deployment checks are recorded.

## 6. Change control

- New work is classified as clarification, defect, replacement, or scope change.
- Material scope changes require the approved project authority and update the charter baseline.
- Prior history is preserved; a new charter/task revision supersedes rather than erases.

## 7. Budget

- Hard and soft limits are enforced at project, phase, WorkItem, run, provider, and tool levels.
- Child limits fit within the parent's remaining budget.
- Warning at 70% and re-plan/pause at 90% of a budget account.
- An agent may recommend a budget increase but cannot grant one.

## 8. Failure and retry

- Retry only transient failures when the operation is idempotent or protected by an idempotency key.
- Apply exponential backoff with jitter and attempt caps.
- Never retry a denial, missing approval, invalid input, or deterministic test failure without a changed condition.
- Honor circuit breakers by dependency.

## 9. Audit

At minimum, record: project/task creation and transitions; agent registration and version selection; prompt-template versions; context manifests; policy decisions; tool-call authorization; approval lifecycle; budget reservations; artifact creation/release; lock lifecycle; test/review/evaluation/deployment outcomes; memory proposals and promotions.

Do not store raw secrets, tokens, passwords, session cookies, or private keys. Store a short decision record, not private chain-of-thought.