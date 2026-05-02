"""Concrete :class:`StockMetaSource` adapters (one module per provider).

Currently AKShare-only — Tushare was dropped to remove the token + heavy
SDK requirement. To add a new source, mirror the AKShare adapter's
``_resolve_gateway`` / ``healthcheck`` / ``fetch_all`` / ``fetch_one``
shape and register it in the composition root.
"""

from quant_io.sources.akshare_stock_meta import AKShareStockMetaSource

__all__ = ["AKShareStockMetaSource"]
