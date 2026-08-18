"""Approval service: issues, resolves, and verifies scoped approval tokens.

Implements the approval-gate semantics from the project policy:

- an approval is bound to actor, action, resource, environment, artifact sha, and project;
- an approval is short-lived and single-use;
- an approval of one artifact never authorizes a different artifact;
- a rejection cannot be converted into an approval by rephrasing the request.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from .contracts import ApprovalRequest, utc_now

Approver = Callable[[ApprovalRequest], bool]


class ApprovalService:
    """In-memory approval registry with token issuance and validation."""

    def __init__(self, ttl_seconds: int = 3600) -> None:
        if ttl_seconds < 0:
            raise ValueError("ttl_seconds must be non-negative")
        self._lock = threading.RLock()
        self._ttl = ttl_seconds
        self._requests: dict[str, ApprovalRequest] = {}
        self._consumed: set[str] = set()

    def request(self, approval: ApprovalRequest) -> ApprovalRequest:
        if approval.decision != "pending":
            raise ValueError("new approval requests must start as pending")
        expires = datetime.now(tz=timezone.utc) + timedelta(seconds=self._ttl)
        approval = replace(
            approval,
            expires_at=expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
            decision="pending",
        )
        with self._lock:
            if approval.request_id in self._requests:
                raise ValueError(f"duplicate approval request: {approval.request_id}")
            self._requests[approval.request_id] = approval
        return approval

    def resolve(self, approval: ApprovalRequest, approver: str, granted: bool, reason: str = "") -> ApprovalRequest:
        with self._lock:
            current = self._requests.get(approval.request_id)
            if current is None:
                raise KeyError(f"unknown approval request: {approval.request_id}")
            if current != approval:
                raise ValueError("approval request does not match the registered request")
            if current.decision != "pending":
                raise ValueError(f"approval already resolved as {current.decision}")
            if self._is_expired(current, utc_now()):
                self._requests[approval.request_id] = replace(current, decision="expired")
                raise ValueError("approval request has expired")
            decision = "approved" if granted else "rejected"
            updated = replace(
                current,
                decision=decision,
                approved_by=approver,
                approved_at=utc_now(),
                reason=reason,
            )
            self._requests[approval.request_id] = updated
            return updated

    def verify(self, approval: ApprovalRequest, now: str | None = None) -> bool:
        """A token is valid only if it is approved, unexpired, and untouched."""
        with self._lock:
            return self._verify_locked(approval, now or utc_now())

    def consume(
        self,
        approval: ApprovalRequest,
        *,
        actor: str,
        action: str,
        resource: str,
        environment: str,
        artifact_sha: str,
        project_id: str,
        gate: str,
        now: str | None = None,
    ) -> bool:
        """Atomically validate and consume a bound approval exactly once."""
        with self._lock:
            if not self._verify_locked(approval, now or utc_now()):
                return False
            expected = (actor, action, resource, environment, artifact_sha, project_id, gate)
            actual = (
                approval.requested_by,
                approval.action,
                approval.resource,
                approval.environment,
                approval.artifact_sha,
                approval.project_id,
                approval.gate,
            )
            if actual != expected:
                return False
            self._consumed.add(approval.request_id)
            return True

    def _verify_locked(self, approval: ApprovalRequest, now: str) -> bool:
        if approval.decision != "approved" or approval.request_id in self._consumed:
            return False
        stored = self._requests.get(approval.request_id)
        if stored is None or stored != approval or stored.decision != "approved":
            return False
        return not self._is_expired(stored, now)

    @staticmethod
    def _is_expired(approval: ApprovalRequest, now: str) -> bool:
        try:
            expires = datetime.strptime(approval.expires_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            current = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            return True
        return current >= expires

    def is_consumed(self, request_id: str) -> bool:
        with self._lock:
            return request_id in self._consumed

    def is_resolved(self, request_id: str) -> bool:
        with self._lock:
            approval = self._requests.get(request_id)
            return approval is not None and approval.decision != "pending"

    def get(self, request_id: str) -> ApprovalRequest | None:
        with self._lock:
            return self._requests.get(request_id)
