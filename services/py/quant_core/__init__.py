"""Quant core: domain types, pure functions, ports, and service orchestration.

Subpackages:
    domain.types  - frozen dataclasses, TypedDicts, Protocols (core asset, no IO)
    domain.pure   - pure functions (core asset, no IO)
    domain.rules  - business-rule pure functions (core asset, no IO)
    services      - business orchestration (depends only on domain + ports)
    ports         - abstract interfaces (Protocol/ABC)
    config        - pydantic-settings configuration
"""
