/**
 * App-side wiring: builds the `DocumentToolAdapter` over App state (read
 * through one ref updated every render, the `headerHandlersRef` pattern) and
 * attaches the phase-1 catalog with `useToolset`.
 *
 * Zero footprint without WebMCP: `useToolset` resolves `document.modelContext`
 * once; when it is absent, the catalog is never built, the tracker never
 * observes, and no effect body runs. Nothing here is rendered.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { getDocPreviewFetcher } from '@plannotator/ui/components/InlineMarkdown';
import type { ViewerHandle } from '@plannotator/ui/components/Viewer';
import type { CachedDocState } from '@plannotator/ui/hooks/useLinkedDoc';
import { AnnotationType, type Annotation, type Block } from '@plannotator/ui/types';
import { useConfigValue } from '@plannotator/ui/config';
import { getWebMcpPolicy, useToolset, type DocumentSurface } from '@plannotator/ui/webmcp';
import {
  buildDocumentHooks,
  buildDocumentTools,
  createDocumentToolState,
  syncTrackers,
  type DocumentSessionView,
  type DocumentSnapshot,
  type DocumentToolAdapter,
  type SessionDecision,
  type SessionMode,
  type SiblingDocument,
} from './documentTools';

export interface DocumentWebMcpInputs {
  isApiMode: boolean;
  isSharedSession: boolean;
  goalSetupMode: boolean;
  annotateMode: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  liveApp: { appUrl: string } | null;
  livePageUrl: string;
  archiveMode: boolean;
  gate: boolean;
  submitted: 'approved' | 'denied' | 'exited' | null;
  renderAs: 'markdown' | 'html';
  rawHtml: string;
  displayedMarkdown: string;
  blocks: Block[];
  allAnnotations: Annotation[];
  isEditingMarkdown: boolean;
  editorDiffersFromBaseline: boolean;
  sourceStale: boolean;
  sourceFilePath: string | undefined;
  sourceInfo: string | undefined;
  versionInfo: { version: number; totalVersions: number } | null;
  linkedDoc: {
    isActive: boolean;
    filepath: string | null;
    getDocAnnotations: () => Map<string, CachedDocState>;
    open: (path: string) => Promise<void>;
  };
  fileBrowserActiveFile: string | null;
  viewerRef: RefObject<ViewerHandle | null>;
  scrollViewport: HTMLElement | null;
  addAnnotation: (annotation: Annotation) => void;
  editAnnotation: (id: string, patch: Partial<Annotation>) => void;
  deleteAnnotation: (id: string) => void;
  selectAnnotation: (id: string | null) => void;
  showBanner: (message: string) => void;
}

const PAINT_DELAY_MS = 50;

function firstHeading(blocks: readonly Block[]): string | null {
  const heading = blocks.find((b) => b.type === 'heading');
  return heading ? heading.content : null;
}

function isComposerOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[data-comment-popover="true"]');
}

export function useDocumentWebMcp(inputs: DocumentWebMcpInputs): { available: boolean; registered: boolean } {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const state = useMemo(() => createDocumentToolState(), []);
  const toolsEnabled = useConfigValue('webmcpTools');

  const surface: DocumentSurface = inputs.liveApp ? 'live-app' : inputs.renderAs === 'html' ? 'html' : 'markdown';
  const writable = !inputs.archiveMode && inputs.submitted === null;
  const folder = inputs.annotateSource === 'folder';
  const active = (inputs.isApiMode || inputs.isSharedSession) && !inputs.goalSetupMode && toolsEnabled !== false;

  const adapter = useMemo<DocumentToolAdapter>(() => {
    const current = () => inputsRef.current;
    const openPath = () => {
      const i = current();
      return i.linkedDoc.filepath ?? i.sourceFilePath ?? null;
    };
    const getDocument = (): DocumentSnapshot => {
      const i = current();
      return {
        path: openPath(),
        text: i.liveApp ? null : i.displayedMarkdown,
        blocks: i.liveApp ? [] : i.blocks,
        annotations: i.allAnnotations,
        html: i.renderAs === 'html' ? i.rawHtml : null,
      };
    };
    const paint = (annotation: Annotation) => {
      if (annotation.type === AnnotationType.GLOBAL_COMMENT || !annotation.originalText) return;
      const viewer = current().viewerRef;
      setTimeout(() => {
        viewer.current?.applySharedAnnotations([annotation]);
      }, PAINT_DELAY_MS);
    };
    const isOpen = (path: string | null) => path === null || path === openPath();
    return {
      getSession(): DocumentSessionView {
        const i = current();
        const mode: SessionMode = i.archiveMode
          ? 'archive'
          : i.isSharedSession && !i.isApiMode
            ? 'shared'
            : i.annotateMode
              ? i.liveApp ? 'annotate-app' : i.annotateSource === 'folder' ? 'annotate-folder' : i.annotateSource === 'message' ? 'annotate-last' : 'annotate'
              : 'plan';
        const decision: SessionDecision = i.submitted === 'approved' ? 'approved' : i.submitted === 'denied' ? 'feedback-sent' : i.submitted === 'exited' ? 'exited' : 'pending';
        const currentSurface: DocumentSurface = i.liveApp ? 'live-app' : i.renderAs === 'html' ? 'html' : 'markdown';
        return {
          mode,
          surface: currentSurface,
          source: {
            title: firstHeading(i.blocks) ?? i.sourceInfo ?? null,
            path: openPath(),
            url: i.liveApp ? i.liveApp.appUrl : null,
          },
          gate: i.gate,
          readOnly: i.archiveMode,
          decision,
          commentOnly: currentSurface !== 'markdown',
          sourceStale: i.sourceStale,
          editing: i.isEditingMarkdown || i.editorDiffersFromBaseline,
          versions: i.versionInfo ? { current: i.versionInfo.version, total: i.versionInfo.totalVersions } : null,
          pageUrl: i.liveApp ? (i.livePageUrl || null) : null,
        };
      },
      getDocument,
      async readDocument(path) {
        const i = current();
        if (!i.isApiMode) return null;
        const cached = i.linkedDoc.getDocAnnotations().get(path);
        if (cached && typeof cached.markdown === 'string') {
          return { path, text: cached.markdown, blocks: parseMarkdownToBlocks(cached.markdown), annotations: cached.annotations };
        }
        if (i.annotateSource !== 'folder' && !cached) return null;
        try {
          const result = await getDocPreviewFetcher()(path);
          if (!result || typeof result.contents !== 'string') return null;
          return { path, text: result.contents, blocks: parseMarkdownToBlocks(result.contents), annotations: cached?.annotations ?? [] };
        } catch {
          return null;
        }
      },
      getSiblingDocuments(): SiblingDocument[] {
        const i = current();
        const open = openPath();
        const siblings: SiblingDocument[] = [];
        for (const [path, cached] of i.linkedDoc.getDocAnnotations()) {
          if (path === open) continue;
          siblings.push({ path, open: false, annotations: cached.annotations, composerOpen: false });
        }
        return siblings;
      },
      getComposer() {
        return { open: isComposerOpen() };
      },
      addAnnotation(annotation, path) {
        if (!isOpen(path)) return false;
        current().addAnnotation(annotation);
        paint(annotation);
        return true;
      },
      updateAnnotation(id, patch, path) {
        if (!isOpen(path)) return false;
        current().editAnnotation(id, patch);
        return true;
      },
      removeAnnotation(id, path) {
        if (!isOpen(path)) return false;
        current().deleteAnnotation(id);
        return true;
      },
      async revealAnnotation(id, path) {
        const i = current();
        if (path !== null && !isOpen(path)) {
          await i.linkedDoc.open(path);
        }
        const exists = current().allAnnotations.some((a) => a.id === id);
        if (!exists) return false;
        current().selectAnnotation(id);
        return true;
      },
      async revealSection(blockId, path) {
        const i = current();
        if (path !== null && !isOpen(path)) {
          await i.linkedDoc.open(path);
        }
        if (typeof document === 'undefined') return false;
        const target = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
        if (!target) return false;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      },
      showBanner(message) {
        current().showBanner(message);
      },
    };
  }, []);

  const result = useToolset({
    id: 'document',
    active,
    build: () => buildDocumentTools(adapter, state, { writable, folder, toolName: (bare) => `${getWebMcpPolicy().namePrefix}${bare}` }),
    deps: [surface, writable, folder],
    hooks: useMemo(() => buildDocumentHooks(adapter, state, (bare) => `${getWebMcpPolicy().namePrefix}${bare}`), [adapter, state]),
  });

  // Observe annotation changes as they happen so tombstones and activity
  // times are real-time rather than call-time. Gated on the provider: a
  // browser without WebMCP never runs the body.
  const annotations = inputs.allAnnotations;
  useEffect(() => {
    if (!result.registered) return;
    syncTrackers(adapter, state);
  }, [adapter, state, annotations, result.registered]);

  return result;
}
