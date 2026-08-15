import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GuideExportButton } from './GuideExportButton';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = originalFetch;
});

async function render(jobId: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<GuideExportButton jobId={jobId} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('GuideExportButton', () => {
  test.skipIf(!hasDom)('offers the download with the server-reported size when the guide is exportable', async () => {
    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ bytes: 345_678, filename: 'guided-review-x.html', languages: ['typescript'] }), { status: 200 }));
    }) as typeof fetch;
    await render('saved:1000-x');
    expect(calls).toEqual(['/api/guide/saved%3A1000-x/export-info']);
    const link = host!.querySelector('a[data-testid="guide-export"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/api/guide/saved%3A1000-x/export');
    expect(link!.getAttribute('download')).toBe('guided-review-x.html');
    expect(link!.textContent).toContain('346 KB');
  });

  test.skipIf(!hasDom)('renders nothing when the guide is not exportable or the preflight fails', async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: 'not retained' }), { status: 404 }))) as typeof fetch;
    await render('job-1');
    expect(host!.querySelector('[data-testid="guide-export"]')).toBeNull();
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    await render('job-2');
    expect(host!.querySelector('[data-testid="guide-export"]')).toBeNull();
  });
});
