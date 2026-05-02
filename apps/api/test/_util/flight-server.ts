/**
 * Helper that spawns the Python Flight test fixture
 * (`python -m quant_rpc`) on an ephemeral port and waits for the
 * "READY <port>" handshake on stdout before resolving. Used by the
 * cross-process contract tests under apps/api/test/contract/.
 *
 * The fixture logs to stderr; we surface that to the Jest console so
 * Python crashes show up next to the failing TS expectation.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const READY_RE = /^READY (\d+)$/m;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface PythonFlightServer {
  readonly port: number;
  readonly target: string;
  shutdown(): Promise<void>;
}

export async function startPythonFlightServer(): Promise<PythonFlightServer> {
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    'uv',
    ['run', 'python', '-m', 'quant_rpc', '--port', '0'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    },
  );

  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[py-flight] ${chunk.toString('utf8')}`);
  });

  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = READY_RE.exec(buffer);
      if (match !== null) {
        child.stdout.off('data', onData);
        const parsed = Number.parseInt(match[1] ?? '', 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          reject(new Error(`Bad port from python: ${match[1] ?? '<empty>'}`));
          return;
        }
        resolve(parsed);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      reject(new Error(`python flight server exited before READY (code=${String(code)})`));
    });
  });

  return {
    port,
    target: `127.0.0.1:${String(port)}`,
    async shutdown(): Promise<void> {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}
