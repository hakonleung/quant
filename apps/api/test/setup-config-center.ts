/**
 * Jest setup: initialise the bootstrap-time ServerConfigCenter so any
 * service constructor that reads through it sees a parsed config in
 * unit tests. Defaults are derived from the empty env (`{}`), which
 * preserves the literal values that used to be inlined in source.
 *
 * Tests that need a different env should call:
 *
 *   ServerConfigCenter.init(customEnv, { force: true });
 *
 * and reset via `__resetForTests()` in `afterEach`.
 */

import { ServerConfigCenter } from '@quant/config/server';

ServerConfigCenter.init({}, { force: true });
