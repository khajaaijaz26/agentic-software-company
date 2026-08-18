"""Locate the prompt, schema, and workflow resources in source and wheels."""

from __future__ import annotations

import os
import sys
from pathlib import Path

RESOURCE_DIRECTORIES = ("prompts", "schemas", "workflows")


def resource_root() -> Path:
    """Return a root containing every runtime resource directory.

    Editable/source checkouts keep resources at the repository root. Wheels
    install the same files under ``sys.prefix/share/agentic_company``.
    ``AGENTIC_COMPANY_RESOURCE_ROOT`` is an explicit deployment override.
    """
    override = os.environ.get("AGENTIC_COMPANY_RESOURCE_ROOT")
    candidates = []
    if override:
        candidates.append(Path(override).expanduser())
    candidates.extend(
        (
            Path(__file__).resolve().parent / "data",
            Path(__file__).resolve().parents[2],
            Path(sys.prefix) / "share" / "agentic_company",
        )
    )
    for candidate in candidates:
        resolved = candidate.resolve()
        if all((resolved / name).is_dir() for name in RESOURCE_DIRECTORIES):
            return resolved
    searched = ", ".join(str(candidate) for candidate in candidates)
    raise FileNotFoundError(f"agentic-company runtime resources not found; searched: {searched}")


RESOURCE_ROOT = resource_root()
PROMPTS_ROOT = RESOURCE_ROOT / "prompts"
SCHEMAS_ROOT = RESOURCE_ROOT / "schemas"
WORKFLOWS_ROOT = RESOURCE_ROOT / "workflows"
