/**
 * Cross-process contract test for the FlightClient (M4b).
 *
 * Spins the real Python Flight server (`python -m quant_rpc`) in a child
 * process and exercises the full wire path: gRPC → Flight protobuf →
 * Arrow IPC reassembly → apache-arrow `Table`. This proves the hand-rolled
 * proto definitions, the IPC stream rebuilder, and the error-envelope
 * parser actually agree with the Python server we ship.
 */

import { QuantError } from '@quant/shared';
import { FlightClient } from '../../src/adapters/flight/flight-client.js';
import { startPythonFlightServer, type PythonFlightServer } from '../_util/flight-server.js';

jest.setTimeout(30_000);

describe('FlightClient ↔ Python QuantFlightServer (contract)', () => {
  let server: PythonFlightServer;
  let client: FlightClient;

  beforeAll(async () => {
    server = await startPythonFlightServer();
    client = new FlightClient(server.target);
  });

  afterAll(async () => {
    client.close();
    await server.shutdown();
  });

  it('round-trips get_stock_meta_batch into an Arrow Table', async () => {
    const result = await client.doGet(
      'get_stock_meta_batch',
      { codes: ['600519', '000858'] },
      { traceId: 'contract-batch-1' },
    );
    const table = result.value;
    expect(table.numRows).toBe(2);
    const codes = table.getChild('code')!.toArray() as unknown as readonly string[];
    expect(Array.from(codes)).toEqual(['600519', '000858']);
    const names = table.getChild('name')!.toArray() as unknown as readonly string[];
    expect(names[0]).toContain('茅台');
  });

  it('returns an empty (but schema-bearing) table for an empty batch', async () => {
    const result = await client.doGet('get_stock_meta_batch', { codes: [] });
    expect(result.value.numRows).toBe(0);
    expect(result.value.schema.fields.map((f) => f.name)).toContain('code');
  });

  it('list_stock_meta_by_industry returns sorted rows', async () => {
    const result = await client.doGet('list_stock_meta_by_industry', { sw_l2: '白酒' });
    const codes = result.value.getChild('code')!.toArray() as unknown as readonly string[];
    expect(Array.from(codes)).toEqual(['000858', '600519']);
  });

  it('translates a server-side STOCK_NOT_FOUND-style failure to QuantError', async () => {
    // The op refuses unknown args shape → INVALID_ARGUMENT
    let caught: unknown = null;
    try {
      await client.doGet('get_stock_meta_batch', { codes: 'not-a-list' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuantError);
    expect((caught as QuantError).code).toBe('INVALID_ARGUMENT');
  });

  it('translates an unknown op to NOT_FOUND', async () => {
    let caught: unknown = null;
    try {
      await client.doGet('definitely-not-an-op', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuantError);
    expect((caught as QuantError).code).toBe('NOT_FOUND');
  });
});
