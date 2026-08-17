# Architecture

## Overview

The Open-Source Agentic Software Company is a governed multi-agent delivery
platform. Its architecture turns the operating principles of the master system
prompt into enforced controls: **evidence before claims**, **least privilege**,
**human authority at material gates**, **one source of truth**, **small
reversible steps**, **independent verification**, **traceable handoffs**, and
**full audit**.

## Components

```
                        ┌──────────────────────────┐
                        │   Orchestrator           │
                        │  (routes task envelopes) │
                        └────────────┬─────────────┘
                                     │
              ┌──────────┬───────────┼──────────────┬──────────────┐
              ▼          ▼           ▼              ▼              ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐
        │  Agent   │ │  Agent   │ │  Agent   │ │  Agent   │ │  Human     │
        │Registry  │ │  Policy  │ │ Approval │ │  Tool    │ │ Approvers  │
        │  (roles) │ │  Engine  │ │ Service  │ │ Gateway  │ │  (gates)   │
        └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────────┘
                                                                │
                                ┌───────────────────────────────┘
                                ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
        │  Event Store │ │  State Store │ │ Artifact     │ │  Prompts     │
        │  (audit,     │ │  (projects,  │ │  Store       │ │  Library     │
        │   append-only)│ │  tasks)      │ │  (content-   │ │  (constitution│
        │              │ │              │ │   addressed) │ │   + roles)   │
        └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## Control flow (delivery)

1. A client request enters via the intake agent; the original request is
   preserved as an immutable artifact.
2. The orchestrator creates the project record and dispatch chain in the state
   store and records `project.created`.
3. Each task is packaged into an immutable **task envelope** carrying identity,
   prompt versions, policy IDs, bound approvals, and budget.
4. The specialist agent receives only the tools, data, and budget its
   capability allows (enforced by the policy engine via the tool gateway).
5. Gated actions (G2–G4) require a **bound, short-lived, single-use approval
   token** from an authorized human. Silence is never approval.
6. The agent returns a **result envelope** with evidence; the orchestrator
   records `task.complete`.
7. Every tool call, approval, and handoff is appended to the event store — the
   audit system of record.

## Approval gates

| Gate | Meaning | Example |
|------|---------|---------|
| G0 | Autonomous read | read a repository |
| G1 | Reversible workspace change | edit source, run local tests |
| G2 | Shared or external non-production effect | open a PR, create staging |
| G3 | Production or sensitive effect | deploy, migrate data |
| G4 | Irreversible, legal, financial, or high-impact | delete prod data, release |

The policy engine maps operations → gates deterministically; environment
escalation (e.g. editing source in prod) raises the gate automatically.

## Reference implementation

The Python package under `src/agentic_company/` is a dependency-free reference
implementation of these components. It is intentionally small and auditable so
the controls can be read end-to-end. Production deployments would replace the
in-memory/file stores with durable infrastructure without changing the
interfaces.

## See also

- `docs/adr/` — architecture decision records
- `docs/protocols/` — protocol notes
- `docs/runbooks/` — operational runbooks
- `docs/security/` — security posture
- `docs/contributing/` — contribution guide