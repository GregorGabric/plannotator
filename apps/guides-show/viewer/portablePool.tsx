import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
// The URL of the emitted worker chunk (relative to this module under the
// relative-base CDN build). NOT `?worker&inline`: inlining would put ~200 KB
// of base64 back into the entry, and NOT a bare `?worker`: Vite would emit
// `new Worker("<absolute cdn url>")`, which browsers reject cross-origin.
import workerUrl from '@pierre/diffs/worker/worker.js?worker&url';

/**
 * Worker-pool highlighting for the portable viewer, mirroring
 * `packages/review-editor/workerPool.tsx` (same sizing, same `shiki-js`
 * engine, same token transformer) with one difference: the worker script is
 * fetched from guides.show and constructed locally, because a document opened
 * from disk (`file://`) or hosted elsewhere is a different origin from the CDN
 * and a cross-origin `new Worker(url)` throws.
 *
 * How the worker is constructed depends on the browser and the document's
 * origin, and the only reliable way to know is to try. Chrome, for one, lets a
 * `file://` document create a *classic* blob worker and a `data:` module
 * worker but refuses a blob *module* worker (it reports the opaque-origin
 * mismatch as "cross-origin redirects of the top-level worker script"), and
 * that refusal is asynchronous — the constructor succeeds and the worker dies
 * with an `error` event. So each strategy is probed with a one-line script
 * that must post a message back; the first that answers is used for the real
 * pool. Nothing answers → main-thread highlighting, exactly like the app when
 * its pool never initializes. The worker bundle is import-free
 * (`inlineDynamicImports`; enforced by check-budgets), so it runs unchanged as
 * a classic worker.
 */
type WorkerStrategy = { kind: 'blob' | 'data'; type: 'module' | 'classic' };

// Classic first: the bundle needs no module semantics (check-budgets asserts
// it stays import-free), classic blob workers are the most widely permitted,
// and probing a blob *module* worker first would log Chrome's refusal on
// every file:// open even though the next strategy succeeds.
const STRATEGIES: readonly WorkerStrategy[] = [
  { kind: 'blob', type: 'classic' },
  { kind: 'blob', type: 'module' },
  { kind: 'data', type: 'classic' },
  { kind: 'data', type: 'module' },
];

const PROBE_TIMEOUT_MS = 1_500;

function toWorkerUrl(source: string, kind: WorkerStrategy['kind']): string {
  if (kind === 'blob') return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const bytes = new TextEncoder().encode(source);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:text/javascript;base64,${btoa(binary)}`;
}

function workerOptions(strategy: WorkerStrategy): WorkerOptions | undefined {
  return strategy.type === 'module' ? { type: 'module' } : undefined;
}

/** True when a trivial worker built this way starts and answers. */
function probeStrategy(strategy: WorkerStrategy): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker?.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    try {
      worker = new Worker(toWorkerUrl('self.postMessage(1)', strategy.kind), workerOptions(strategy));
      worker.onmessage = () => finish(true);
      worker.onerror = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

export async function preparePortableWorkerFactory(): Promise<(() => Worker) | null> {
  try {
    if (typeof Worker === 'undefined' || typeof fetch === 'undefined') return null;
    const resolved = new URL(workerUrl, import.meta.url).href;
    const response = await fetch(resolved, { mode: 'cors' });
    if (!response.ok) return null;
    const source = await response.text();
    for (const strategy of STRATEGIES) {
      if (!(await probeStrategy(strategy))) continue;
      const url = toWorkerUrl(source, strategy.kind);
      const options = workerOptions(strategy);
      document.documentElement.dataset.pgrWorker = `${strategy.kind}-${strategy.type}`;
      return () => new Worker(url, options);
    }
    return null;
  } catch {
    return null;
  }
}

const highlighterOptions: WorkerInitializationRenderOptions = {
  preferredHighlighter: 'shiki-js',
  useTokenTransformer: true,
  langs: ['typescript', 'tsx', 'javascript', 'json', 'css', 'html', 'python', 'go', 'rust', 'sh', 'yaml', 'markdown'],
};

// A pool whose workers die after construction never reports failure — the
// initialize round-trip simply never returns — and Pierre renders nothing
// while it waits. If the pool is not initialized by then, the provider is
// dropped and the same tree re-renders on the main thread.
const POOL_READY_TIMEOUT_MS = 4_000;

function PoolWatchdog({ onDead }: { onDead: () => void }) {
  const pool = useWorkerPool();
  useEffect(() => {
    if (pool == null) return;
    if (pool.isInitialized()) return;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) onDead();
    }, POOL_READY_TIMEOUT_MS);
    const unsubscribe = pool.subscribeToStatChanges((stats) => {
      if (stats.managerState === 'initialized') ready = true;
      if (stats.workersFailed) onDead();
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [pool, onDead]);
  return null;
}

export function PortableWorkerPool({ workerFactory, children }: { workerFactory: () => Worker; children: ReactNode }) {
  const [dead, setDead] = useState(false);
  const onDead = useCallback(() => {
    console.warn('Plannotator: highlight worker pool never initialized — rendering on the main thread.');
    document.documentElement.dataset.pgrHighlighter = 'main-thread';
    setDead(true);
  }, []);
  const poolOptions: WorkerPoolOptions = {
    poolSize: Math.min(Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1), 3),
    totalASTLRUCacheSize: 100,
    workerFactory,
  };
  if (dead) return <>{children}</>;
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <PoolWatchdog onDead={onDead} />
      {children}
    </WorkerPoolContextProvider>
  );
}
