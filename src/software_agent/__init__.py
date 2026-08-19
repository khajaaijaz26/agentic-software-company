"""Public Python compatibility surface for Software Agent.

The TypeScript terminal application is the sole controller. This package
re-exports the maintained Python reference contracts and MCP adapter for
existing integrations without creating a second product identity.
"""

from agentic_company import *  # noqa: F401,F403
from agentic_company import __all__, __version__
