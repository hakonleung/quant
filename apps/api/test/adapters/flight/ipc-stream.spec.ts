import { buildIpcStream, type FlightDataChunk } from '../../../src/adapters/flight/ipc-stream.js';

describe('buildIpcStream', () => {
  it('emits a single end-of-stream marker for an empty input', () => {
    const out = buildIpcStream([]);
    expect(out.byteLength).toBe(8);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(0, true)).toBe(0xffffffff);
    expect(view.getUint32(4, true)).toBe(0);
  });

  it('pads the header to an 8-byte boundary', () => {
    // header length 5 → padded to 8
    const chunk: FlightDataChunk = {
      dataHeader: new Uint8Array([1, 2, 3, 4, 5]),
      dataBody: new Uint8Array(),
    };
    const out = buildIpcStream([chunk]);
    // 4 cont + 4 len + 8 padded header + 0 body + 8 EOS = 24
    expect(out.byteLength).toBe(24);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(0, true)).toBe(0xffffffff);
    expect(view.getUint32(4, true)).toBe(8); // padded length
    // Header bytes preserved at offset 8..13
    expect(Array.from(out.slice(8, 13))).toEqual([1, 2, 3, 4, 5]);
    // Padding bytes are zero
    expect(Array.from(out.slice(13, 16))).toEqual([0, 0, 0]);
  });

  it('appends body bytes after the padded header', () => {
    const chunk: FlightDataChunk = {
      dataHeader: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      dataBody: new Uint8Array([9, 10, 11]),
    };
    const out = buildIpcStream([chunk]);
    // 4 + 4 + 8 + 3 + 8 = 27
    expect(out.byteLength).toBe(27);
    expect(Array.from(out.slice(16, 19))).toEqual([9, 10, 11]);
  });

  it('handles an already-aligned header without extra padding', () => {
    const chunk: FlightDataChunk = {
      dataHeader: new Uint8Array(8).fill(0xab),
      dataBody: new Uint8Array(),
    };
    const out = buildIpcStream([chunk]);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(4, true)).toBe(8);
  });

  it('emits multiple chunks back-to-back plus EOS', () => {
    const chunks: FlightDataChunk[] = [
      { dataHeader: new Uint8Array(8).fill(1), dataBody: new Uint8Array() },
      { dataHeader: new Uint8Array(8).fill(2), dataBody: new Uint8Array(8).fill(9) },
    ];
    const out = buildIpcStream(chunks);
    // 16 (chunk1: 4+4+8+0) + 24 (chunk2: 4+4+8+8) + 8 (EOS) = 48
    expect(out.byteLength).toBe(48);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(view.getUint32(40, true)).toBe(0xffffffff);
    expect(view.getUint32(44, true)).toBe(0);
  });
});
