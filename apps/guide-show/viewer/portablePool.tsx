import React, { type ReactNode } from 'react';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
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
 * fetched from guide.show and constructed from a blob URL, because a document
 * opened from disk (`file://`) or hosted elsewhere is a different origin from
 * the CDN and a cross-origin `new Worker(url)` throws. Any failure — no
 * `Worker`, fetch blocked, blob workers refused — degrades to main-thread
 * highlighting, exactly like the app does when its pool never initializes.
 */
export async function preparePortableWorkerFactory(): Promise<(() => Worker) | null> {
  try {
    if (typeof Worker === 'undefined' || typeof fetch === 'undefined') return null;
    const resolved = new URL(workerUrl, import.meta.url).href;
    const response = await fetch(resolved, { mode: 'cors' });
    if (!response.ok) return null;
    const source = await response.text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    // Probe once: some browsers refuse blob workers from an opaque origin and
    // throw synchronously; better to learn that here than inside Pierre.
    const probe = new Worker(blobUrl, { type: 'module' });
    probe.terminate();
    return () => new Worker(blobUrl, { type: 'module' });
  } catch {
    return null;
  }
}

const highlighterOptions: WorkerInitializationRenderOptions = {
  preferredHighlighter: 'shiki-js',
  useTokenTransformer: true,
  langs: ['typescript', 'tsx', 'javascript', 'json', 'css', 'html', 'python', 'go', 'rust', 'sh', 'yaml', 'markdown'],
};

export function PortableWorkerPool({ workerFactory, children }: { workerFactory: () => Worker; children: ReactNode }) {
  const poolOptions: WorkerPoolOptions = {
    poolSize: Math.min(Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1), 3),
    totalASTLRUCacheSize: 100,
    workerFactory,
  };
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}
