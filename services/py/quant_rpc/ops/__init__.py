"""Concrete Flight op handlers (one module per business feature).

Each module exposes one or more :class:`quant_rpc.FlightHandler`
implementations. Composition root (the eventual ``quant_rpc/main.py``)
wires them into a :class:`HandlerRegistry`.
"""
