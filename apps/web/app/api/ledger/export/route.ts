/**
 * BFF: GET /api/ledger/export → JSON download (passthrough).
 */

import { nestProxy } from '../../_lib/proxy.js';

export async function GET(request: Request): Promise<Response> {
  return nestProxy(request, '/api/ledger/export');
}
