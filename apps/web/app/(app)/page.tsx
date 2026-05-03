'use client';

import { EqtyModule } from '../../components/modules/eqty-module.js';
import { StocksModule } from '../../components/modules/stocks-module.js';
import { useUiStore, type ModuleId } from '../../lib/stores/ui.store.js';

const MODULES: Readonly<Record<ModuleId, () => React.ReactElement>> = {
  eqty: EqtyModule,
  stocks: StocksModule,
};

export default function WorkbenchPage(): React.ReactElement {
  const view = useUiStore((s) => s.view);
  const Module = MODULES[view];
  return <Module />;
}
