# Production Policy

> Version 1.0 — 17 August 2026
> Owner: Maintainers / Production Approver
> Scope: Applies to any action that affects production systems, live data, real customers, public releases, or external communications.

## 1. Purpose

Production is a high-risk environment. This policy defines the strict authorization, evidence, and reversibility requirements that apply before, during, and after any production-impacting action.

## 2. Pre-conditions for any production action

A production action may begin only when ALL of the following are true:

1. The action is within the approved project scope and task envelope.
2. An explicit, scoped, signed approval token exists for the exact action, resource, environment, artifact version, and time window.
3. The approval token is re-validated immediately before the side effect.
4. A release plan, rollback plan, backup proof, and monitoring thresholds exist and were reviewed.
5. Required independent reviews, QA, security, and reliability evidence passed.
6. The authorized Production Approver has recorded a decision. Silence is not approval.

## 3. Approval requirements

| Action class | Approval |
|--------------|----------|
| Deploy a verified artifact | Named Production Approver |
| Migrate production data | Named Production Approver + Data Owner |
| Rotate a credential / secret | Named Security Approver |
| Access restricted customer data | Named Security/Privacy Approver, time-bounded |
| Send customer communication | Named Account/Communication owner |
| Delete production data | G4: dual approval + recovery plan |
| Publish a public release | Named release authority + security disclosure coordination |
| Emergency bypass | Audited, time-bound, reviewed afterward |

## 4. Release rules

- Release only a previously verified immutable artifact. A release cannot use an artifact different from the approved and tested artifact.
- Use a gradual strategy where justified: feature flag, canary, rolling, or blue/green.
- Run non-destructive smoke tests that do not corrupt real data.
- Observe technical and business signals for the defined period.
- Continue, pause, disable, or roll back according to predetermined thresholds.
- Report `RELEASED` only after the deployment service and post-deployment evidence confirm success.

## 5. Rollback and recovery

- Distinguish application rollback, feature disablement, configuration rollback, and database recovery.
- Database changes use expand-migrate-contract by default.
- Never assume an irreversible migration can be fixed by redeploying old code.
- A completed backup job is not proof of recoverability; perform scheduled restore tests.

## 6. Incident response

- Assign an Incident Commander; separate operations, investigation, and communication roles where possible.
- Contain immediate harm using approved controls.
- Preserve evidence and audit data.
- Communicate factual updates on a cadence; never speculate.
- Suspected personal-data exposure, secret compromise, destructive attack, or legal/regulatory impact immediately involves security, privacy, legal, and executive authorities. Agents never make legal breach notifications on their own.

## 7. Post-production operations

- Operate availability, latency, traffic, errors, saturation, jobs, queues, billing/webhook health, email delivery, database health, security events, backups, dependency status, and cost.
- Maintain on-call schedules, runbooks, status communication, vulnerability/patch processes, access reviews, capacity forecasts, restore exercises, and incident reviews.
- Operability is part of completion; it is never optional.