"""Cache adapters — concrete implementations of ``quant_core.ports.cache``.

This package is the **adapter layer** in the layered architecture
(CLAUDE.md §2.3): it depends on ``quant_core.ports`` (and stdlib + pyarrow +
filelock) and is depended on by RPC / workflow / service composition only.
Domain code never imports from here.
"""
