/**
 * guides.show viewer entry — mounts a portable Guided Review from the snapshot
 * embedded in the exported HTML (`#plannotator-guided-review`).
 *
 * Boot order is load-bearing:
 *   1. install an in-memory settings backend BEFORE anything reads a setting
 *      (configStore seeds defaults on first read; on `file://` cookies would
 *      either fail or leak into the reader's other pages),
 *   2. read + parse the snapshot,
 *   3. try to prepare a worker (fetch → blob); fall back to main thread,
 *   4. render the same guide chain the review app renders.
 *
 * Decision record: adr/decisions/007-portable-guided-reviews-20260815.md.
 */
import '@plannotator/review-editor/styles';
import './portable.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
// setStorageBackend directly (not configurePlannotatorUI): the configure barrel
// statically imports every host seam and their UI, which drags markdown/math
// renderers into a bundle that never uses them.
import { setStorageBackend } from '@plannotator/ui/utils/storage';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { readEmbeddedGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import { GuideViewer } from '@plannotator/guide-viewer';
import { ReadOnlyDiffRenderer, getReadOnlyDiffRendererProps } from './ReadOnlyDiffRenderer';
import { PortableWorkerPool, preparePortableWorkerFactory } from './portablePool';

// 1. Settings live in memory for the life of the page.
const memory = new Map<string, string>();
setStorageBackend({
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
});

function SourceLine({ snapshot }: { snapshot: GuideSnapshot }) {
  const s = snapshot.source;
  const parts: React.ReactNode[] = [];
  if (s.kind === 'pr' && s.pr) {
    parts.push(
      <a key="pr" href={s.pr.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">
        {s.pr.number !== undefined ? `PR #${s.pr.number}` : 'Pull request'}
        {s.pr.title ? ` — ${s.pr.title}` : ''}
      </a>,
    );
  } else if (s.kind === 'commit') {
    parts.push(<span key="c">commit {s.commitSha ? s.commitSha.slice(0, 12) : ''}</span>);
  } else if (s.kind === 'workspace') {
    parts.push(<span key="w">multi-repository workspace</span>);
  } else {
    parts.push(<span key="l">local changes</span>);
  }
  if (s.repo) parts.push(<span key="repo"> · {s.repo}</span>);
  if (s.branch) parts.push(<span key="branch"> · {s.branch}</span>);
  parts.push(<span key="ref"> · {snapshot.review.gitRef}</span>);
  return <>{parts}</>;
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto mt-16 max-w-[60ch] rounded-lg border border-border bg-card px-6 py-5">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function App({ snapshot, workerFactory }: { snapshot: GuideSnapshot; workerFactory: (() => Worker) | null }) {
  const view = (
    <GuideViewer
      snapshot={snapshot}
      DiffRenderer={ReadOnlyDiffRenderer}
      getDiffRendererProps={getReadOnlyDiffRendererProps}
      sourceLine={<SourceLine snapshot={snapshot} />}
      className="min-h-screen bg-background text-foreground"
    />
  );
  return workerFactory ? <PortableWorkerPool workerFactory={workerFactory}>{view}</PortableWorkerPool> : view;
}

async function boot() {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('portable guide: #root missing');

  // 2. Snapshot. In dev (no exported document) fall back to a fixture so the
  //    viewer can be iterated on with `vite`.
  let parsed = readEmbeddedGuideSnapshot(document);
  if (!parsed && import.meta.env.DEV) {
    const { FIXTURE_V1_PR } = await import('@plannotator/core/guide-format-fixtures');
    parsed = { ok: true, value: FIXTURE_V1_PR };
  }

  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  const palette = parsed?.ok ? parsed.value.theme?.palette : undefined;
  // The exported document paints a plain fallback ground until we mount; from
  // here on the theme owns the body background.
  document.body.classList.remove('pgr-fallback-body');
  const root = createRoot(rootEl);
  const shell = (children: React.ReactNode) => (
    <React.StrictMode>
      <ThemeProvider defaultTheme={prefersLight ? 'light' : 'dark'} defaultColorTheme={palette ?? 'plannotator'}>
        <TooltipProvider delayDuration={200} skipDelayDuration={100}>{children}</TooltipProvider>
      </ThemeProvider>
    </React.StrictMode>
  );

  if (!parsed) {
    root.render(shell(<ErrorCard title="No guide found in this document" detail={`Expected a <script id="plannotator-guided-review" type="application/json"> element.`} />));
    return;
  }
  if (!parsed.ok) {
    root.render(shell(<ErrorCard title="This guide could not be opened" detail={`${parsed.error.path}: ${parsed.error.message}`} />));
    return;
  }

  // 3. Worker (best effort), then 4. render.
  const workerFactory = await preparePortableWorkerFactory();
  // Observable for smoke tests and support: which highlighting path this page took.
  document.documentElement.dataset.pgrHighlighter = workerFactory ? 'worker' : 'main-thread';
  root.render(shell(<App snapshot={parsed.value} workerFactory={workerFactory} />));
}

void boot();
