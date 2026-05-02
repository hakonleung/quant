"""IO adapter layer (CLAUDE.md §2.3).

Wraps third-party data-source SDKs behind the
:class:`quant_core.ports.stock_meta_source.StockMetaSource` (and future
KLine / news) ports. Heavy SDK dependencies (``tushare``, ``akshare``)
are imported lazily so the project still installs and runs in
environments where the underlying provider is unavailable.
"""
