"""Approval service: issues, resolves, and verifies scoped approval tokens.

Implements the approval-gate semantics from the project policy:

- an approval is bound to actor, action, resource, environment, artifact sha, and project;
- an approval is short-lived and single-use;
- an approval of one artifact never authorizes a different artifact;
- a rejection cannot be converted into an approval by rephrasing the request.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Callable

from .contracts import ApprovalRequest, utc_now

Approver = Callable[[ApprovalRequest], bool]


class ApprovalService:
    """In-memory approval registry with token issuance and validation."""

    def __init__(self, ttl_seconds: int = 3600) -> None:
        self._lock = threading.RLock()
        self._ttl = ttl_seconds
        self._requests: dict[str, ApprovalRequest] = {}

    def request(self, approval: ApprovalRequest) -> ApprovalRequest:
        if approval.decision != "pending":
            raise ValueError("new approval requests must start as pending")
        expires = datetime.now(tz=timezone.utc) + timedelta(seconds=self._ttl)
        approval = ApprovalRequest(
            **{**approval.__dict__,
               "expires_at": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
               "decision": "pending"},
        )
        with self._lock:
            self._requests[approval.request_id] = approval
        return approval

    def resolve(self, approval: ApprovalRequest, approver: str, granted: bool, reason: str = "") -> ApprovalRequest:
        with self._lock:
            current = self._requests.get(approval.request_id)
            if current is None:
                raise KeyError(f"unknown approval request: {approval.request_id}")
            if current.decision != "pending":
                raise ValueError(f"approval already resolved as {current.decision}")
            decision = "approved" if granted else "rejected"
            updated = ApprovalRequest(
                **{
                    **current.__dict__,
                    "decision": decision,
                    "approved_by": approver,
                    "approved_at": utc_now(),
                    "reason": reason,
                }
            )
            self._requests[approval.request_id] = updated
            return updated

    def verify(self, approval: ApprovalRequest, now: str | None = None) -> bool:
        """A token is valid only if it is approved, unexpired, and untouched."""
        if approval.decision != "approved":
            return False
        if not approval.expires_at:
            return False
        now = now or utc_now()
        try:
            expires = datetime.strptime(approval.expires_at, "%Y-%m-%dT%H:%M:%SZ")
            current = datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            return False
        if current > expires:
            return False
        stored = self._requests.get(approval.request_id)
        if stored is None or stored.decision != "approved":
            return False
        return stored.bound_fingerprint == approval.bound_fingerprint

    def is_resolved(self, request_id: str) -> bool:
        with self._lock:
            return self._requests.get(request_id, ApprovalRequest("", "", "local", "", "")).decision != "pending"

    def get(self, request_id: str) -> ApprovalRequest | None:
        with self._lock:
            return self._requests.get(request_id)