"""Port (Protocol/ABC) definitions consumed by domain + business code.

Ports are the **inversion boundary** between business logic and infrastructure
(CLAUDE.md §2.3). Adapters live elsewhere; domain code depends only on these
abstract interfaces.
"""

from quant_core.ports.cache import KeyValueStore, RecordRepo, TimeSeriesStore
from quant_core.ports.clock import Clock

__all__ = [
    "Clock",
    "KeyValueStore",
    "RecordRepo",
    "TimeSeriesStore",
]
