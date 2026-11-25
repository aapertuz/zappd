import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { Socket } from 'node:net';
import path from 'node:path';
import { type Interface, createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { z } from 'zod';

type CadBuildOptions = {
  readonly archetypeId: string;
  readonly outputDir: string;
  readonly cacheDir: string;
  readonly injectCollisionTest?: boolean;
  readonly renderViewsDir?: string;
};

type CadBuildRequest = CadBuildOptions &
  (
    | { readonly cmd: 'build'; readonly parameterValues?: Readonly<Record<string, number>> }
    | { readonly cmd: 'rebuild_params'; readonly parameterValues: Readonly<Record<string, number>> }
  );

type CadWorkerRequest = CadBuildRequest | { readonly cmd: 'ping' | 'shutdown' };

const workerReplySchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.number(),
    ok: z.literal(true),
    result: z.unknown().optional(),
    pid: z.number().optional(),
  }),
  z.object({ id: z.number(), ok: z.literal(false), error: z.string() }),
]);

type Worker = {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly lines: Interface;
  readonly closed: Promise<void>;
  readonly getStderr: () => string;
};

class CadWorkerExited extends Error {}

type WarmCadState = {
  worker: Worker | undefined;
  nextRequestId: number;
  queue: Promise<void>;
};

const warmCadStateKey = Symbol.for('zappd.warmCadState');

function createWarmCadState(): WarmCadState {
  const state: WarmCadState = { worker: undefined, nextRequestId: 0, queue: Promise.resolve() };
  process.once('exit', () => state.worker?.child.kill());
  return state;
}

const serverGlobal: typeof globalThis & { [warmCadStateKey]?: WarmCadState } = globalThis;
const state = (serverGlobal[warmCadStateKey] ??= createWarmCadState());

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.queue.then(operation);
  state.queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function startWorker(): Worker {
  const child = spawn(
    path.resolve('backend/.venv/bin/python'),
    [path.resolve('backend/cad_worker/warm_worker.py')],
    { stdio: 'pipe' },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-2048);
  });

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => {
      if (state.worker === started) state.worker = undefined;
      resolve();
    });
  });
  const started = { child, lines, closed, getStderr: () => stderr.trim() };
  child.on('error', () => lines.close());
  child.stdin.on('error', () => lines.close());
  return started;
}

function setWorkerReferenced({ child }: Worker, referenced: boolean): void {
  child[referenced ? 'ref' : 'unref']();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream instanceof Socket) {
      stream[referenced ? 'ref' : 'unref']();
    }
  }
}

function exchange(activeWorker: Worker, request: CadWorkerRequest): Promise<unknown> {
  const { child, lines, getStderr } = activeWorker;
  const id = ++state.nextRequestId;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      lines.off('line', receive);
      lines.off('close', disconnected);
    };
    const disconnected = () => {
      cleanup();
      const diagnostic = getStderr() || 'The protocol stream closed';
      reject(new CadWorkerExited(`CAD worker exited: ${diagnostic}`));
    };
    const receive = (line: string) => {
      cleanup();
      try {
        const raw: unknown = JSON.parse(line);
        const reply = workerReplySchema.parse(raw);
        if (reply.id !== id) {
          throw new Error('CAD worker reply ID did not match the request');
        }
        if (!reply.ok) {
          throw new Error(reply.error);
        }
        resolve(request.cmd === 'ping' ? reply.pid : reply.result);
      } catch (error) {
        reject(error);
      }
    };
    if (child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
      disconnected();
      return;
    }
    lines.once('line', receive);
    lines.once('close', disconnected);
    child.stdin.write(JSON.stringify({ ...request, id }) + '\n');
  });
}

async function requestWarmWorker(request: CadBuildRequest, retry: boolean): Promise<unknown> {
  const activeWorker = (state.worker ??= startWorker());
  setWorkerReferenced(activeWorker, true);
  try {
    return await exchange(activeWorker, request);
  } catch (error) {
    if (!(error instanceof CadWorkerExited)) {
      throw error;
    }
    state.worker = undefined;
    activeWorker.child.kill();
    await activeWorker.closed;
    if (retry) {
      return requestWarmWorker(request, false);
    }
    throw error;
  } finally {
    setWorkerReferenced(activeWorker, false);
  }
}

export function requestWarmCadBuild(request: CadBuildRequest): Promise<unknown> {
  return enqueue(() => requestWarmWorker(request, true));
}

export function shutdownWarmCadWorker(): Promise<void> {
  return enqueue(async () => {
    const activeWorker = state.worker;
    if (activeWorker === undefined) {
      return;
    }
    state.worker = undefined;
    setWorkerReferenced(activeWorker, true);
    try {
      await exchange(activeWorker, { cmd: 'shutdown' });
    } catch (error) {
      activeWorker.child.kill();
      if (!(error instanceof CadWorkerExited)) {
        throw error;
      }
    } finally {
      await activeWorker.closed;
    }
  });
}
