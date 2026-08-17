# Data Handling Policy

> Version 1.0 — 17 August 2026
> Owner: Maintainers / Security-Private Approver
> Scope: Applies to every agent, tool, and workflow that collects, stores, processes, retrieves, or shares data.

## 1. Purpose

This policy enforces data minimization, classification, tenant isolation, retention, and redaction across the platform so that no agent can leak, misuse, or over-retain data.

## 2. Data classification

Data is classified at ingestion. Minimum classes:

| Class | Example | Handling |
|-------|---------|----------|
| Public | Approved README, marketing copy | No special handling |
| Internal | Architecture docs, non-sensitive telemetry | Access controlled by project |
| Confidential | Client business data, requirements, source | Scoped project access; redaction in logs |
| Restricted | Personal data, payment data, credentials, tenant secrets | Tenant-aware access; encryption; strict retention; broker by handle |

## 3. Collection and minimization

- Collect only the data needed for the task.
- Challenge any data field or retention that lacks a documented purpose.
- Never copy raw personal data into requirements, prompts, logs, or test systems without an approved purpose and handling method.
- Mask secrets and unnecessary personal data.

## 4. Tenant isolation

- Tenant identity is carried and checked server-side at every relevant data access.
- Never reveal whether another tenant/account exists.
- Separate tenants in identity, storage, retrieval indexes, queues, logs, and encryption boundaries.
- Tenant-aware authorization applies to reads, writes, exports, searches, files, jobs, caches, and support tooling.

## 5. Secrets

- Broker secrets by opaque handles; never insert raw secrets into model context, logs, or artifacts.
- Use short-lived credentials bound to the run and environment.
- Never store raw secrets, access tokens, passwords, session cookies, or private keys in audit logs, repositories, or artifacts.
- Implement rotation, revocation, expiry, and break-glass procedures.

## 6. Redaction and logging

- Redact sensitive request/response fields at ingestion.
- Keep operational logs and audit records separate when their retention or access requirements differ.
- Limit log access by role and record log access for sensitive projects.
- Do not store private chain-of-thought. Store a short decision record.

## 7. Retention and deletion

- Apply retention, deletion, and archival policies per data class and region.
- Implement deletion as auditable, retryable workflows covering primary data, derived data, files, search indexes, caches, and downstream processors.
- Preserve deletion tombstones where legally permitted.
- Provide tested export/deletion workflows for tenants.

## 8. Migration and test data

- Production data is not copied to lower environments unless a specifically approved masking process makes it safe.
- Use synthetic data generators, stable reference sets, and tenant-separated accounts in tests.
- Approved masked data requires an explicit approval path.

## 9. Incidents

- Suspected personal-data exposure, secret compromise, or tenant-boundary failure immediately involves the designated security, privacy, legal, and executive authorities.
- Agents do not decide whether statutory notification is required and never make breach notifications on their own.