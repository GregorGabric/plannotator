/**
 * The Settings opt-out (DOM-gated): flipping the cookie-only `webmcpTools`
 * setting off aborts every registered tool through the App-facing hook and
 * flipping it back re-registers them; a tool call that succeeds through the
 * hook stamps the comment `browser-agent` and records activity (the
 * indicator's only trigger), while nothing is recorded before any call.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configStore } from '@plannotator/ui/config';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getWebMcpActivity, resetWebMcpActivity } from '@plannotator/ui/webmcp';
import type { ModelContextLike, ModelContextToolDescriptor } from '@plannotator/ui/webmcp';
import type { Annotation } from '@plannotator/ui/types';

const hasDom = typeof document !== 'undefined';
const hookModule = hasDom ? await import('./useDocumentWebMcp') : null;

interface FakeContext extends ModelContextLike {
  tools: Map<string, ModelContextToolDescriptor>;
}

function fakeContext(): FakeContext {
  const tools = new Map<string, ModelContextToolDescriptor>();
  return {
    tools,
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => { tools.delete(tool.name); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
    },
  };
}

const originalDescriptor = hasDom ? Object.getOwnPropertyDescriptor(document, 'modelContext') : undefined;

const PLAN = '# Plan\n\nRotate the key.\n';

function Harness({ annotations, onAdd }: { annotations: Annotation[]; onAdd: (a: Annotation) => void }) {
  hookModule!.useDocumentWebMcp({
    isApiMode: true, isSharedSession: false, goalSetupMode: false, annotateMode: false, annotateSource: null,
    liveApp: null, livePageUrl: '', archiveMode: false, gate: false, submitted: null, renderAs: 'markdown', rawHtml: '',
    displayedMarkdown: PLAN, blocks: parseMarkdownToBlocks(PLAN), allAnnotations: annotations,
    isEditingMarkdown: false, editorDiffersFromBaseline: false, sourceStale: false, sourceFilePath: '/plan.md', sourceInfo: undefined,
    versionInfo: null, linkedDoc: { isActive: false, filepath: null, getDocAnnotations: () => new Map(), open: async () => {} },
    fileBrowserActiveFile: null, viewerRef: { current: null }, scrollViewport: null,
    addAnnotation: onAdd, editAnnotation: () => {}, deleteAnnotation: () => {}, selectAnnotation: () => {}, showBanner: () => {},
  });
  return null;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  resetWebMcpActivity();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  configStore.set('webmcpTools', true);
  if (originalDescriptor) Object.defineProperty(document, 'modelContext', originalDescriptor);
  else delete (document as unknown as Record<string, unknown>).modelContext;
});

describe.skipIf(!hasDom)('useDocumentWebMcp', () => {
  test('the webmcpTools setting unregisters and re-registers the whole catalog', async () => {
    const ctx = fakeContext();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: ctx });
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness annotations={[]} onAdd={() => {}} />);
    });
    expect([...ctx.tools.keys()].sort()).toEqual([
      'plannotator.add_comments', 'plannotator.nudge_user', 'plannotator.read_document',
      'plannotator.remove_comments', 'plannotator.reveal', 'plannotator.update_comment',
    ]);
    expect(getWebMcpActivity().calls).toBe(0);

    await act(async () => { configStore.set('webmcpTools', false); });
    expect(ctx.tools.size).toBe(0);

    await act(async () => { configStore.set('webmcpTools', true); });
    expect(ctx.tools.size).toBe(6);
  });

  test('a successful add_comments through the hook stamps browser-agent and records activity', async () => {
    const ctx = fakeContext();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: ctx });
    const added: Annotation[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(<Harness annotations={[]} onAdd={(a) => added.push(a)} />);
    });
    const tool = ctx.tools.get('plannotator.add_comments')!;
    const response = (await tool.execute({ comments: [{ quote: 'Rotate the key', text: 'Grace window?' }] }, { signal: new AbortController().signal })) as { ok: boolean };
    expect(response.ok).toBe(true);
    expect(added.length).toBe(1);
    expect(added[0]).toMatchObject({ source: 'browser-agent', author: 'browser-agent', originalText: 'Rotate the key', text: 'Grace window?' });
    expect(getWebMcpActivity()).toEqual({ calls: 1, lastTool: 'add_comments' });
  });
});
