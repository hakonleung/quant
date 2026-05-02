import type { ReactNode } from 'react';
import { greet } from '../lib/fp/greet.js';

export default function HomePage(): ReactNode {
  return (
    <main>
      <h1>{greet('Quant')}</h1>
      <p>Workbench placeholder. See docs/modules/07-frontend.md for the planned UI.</p>
    </main>
  );
}
