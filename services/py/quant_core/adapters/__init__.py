"""Concrete adapters that satisfy the ``quant_core.ports`` protocols.

Adapters live here when they have **no external dependency beyond the
Python stdlib** (e.g. ``SystemClock``). Adapters that pull in heavier
runtimes (Parquet, Redis, gRPC) live in dedicated sibling packages such
as ``quant_cache``, ``quant_io``, ``quant_rpc``.
"""
