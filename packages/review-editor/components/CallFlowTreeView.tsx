import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CallFlowNode, CallFlowTree } from '@plannotator/shared/call-flow-types';
import { CommentPopover, type CommentTargetChip } from '@plannotator/ui/components/CommentPopover';
import type { CallFlowAnnotationTarget, SelectedLineRange } from '@plannotator/ui/types';
import {
  computeComposerYield,
  distanceToRect,
  type ComposerYieldState,
} from '@plannotator/ui/utils/composerYield';
import { splitCallFlowFilePath } from '../utils/callFlowPresentation';

/** Map a located CallDiff node to the old/new source range used by code review. */
export function selectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  if (!node.line) return null;
  return {
    start: node.line,
    end: node.endLine && node.endLine >= node.line ? node.endLine : node.line,
    side: node.status === 'removed' ? 'deletions' : 'additions',
  };
}

/** Return the source range for any located Call Flow step. */
export function annotationSelectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  return selectionForCallFlowNode(node);
}

/** Build the durable source metadata carried by a Call Flow annotation. */
export function annotationTargetForCallFlowNode(
  node: CallFlowNode,
  entry: string,
  treePath: string,
): CallFlowAnnotationTarget | null {
  const range = annotationSelectionForCallFlowNode(node);
  return {
    treePath,
    entry,
    label: node.label,
    ...(node.file ? { filePath: node.file } : {}),
    ...(range ? {
      lineStart: Math.min(range.start, range.end),
      lineEnd: Math.max(range.start, range.end),
    } : {}),
    side: range?.side === 'deletions' || node.status === 'removed' ? 'old' : 'new',
  };
}

function statusGlyph(status: CallFlowNode['status']): string {
  if (status === 'added') return '+';
  if (status === 'removed') return '−';
  return '·';
}

interface CallFlowNodeRowProps {
  readonly node: CallFlowNode;
  readonly entry: string;
  readonly depth: number;
  readonly treePath: string;
  readonly onOpen: (node: CallFlowNode) => void;
  readonly onAnnotate?: (
    target: CallFlowAnnotationTarget,
    anchor: HTMLElement,
    extend: boolean,
  ) => void;
  readonly selectedTargetKeys: ReadonlySet<string>;
  readonly focusFiles?: ReadonlySet<string>;
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  /** Nodes on a path to at least one added/removed step. */
  readonly changedSubtrees: ReadonlySet<CallFlowNode>;
  readonly showAllContext: boolean;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly fileBoundaryPaths: ReadonlySet<string>;
  readonly onToggleNode: (treePath: string) => void;
}

function CallFlowNodeRow({
  node,
  entry,
  depth,
  treePath,
  onOpen,
  onAnnotate,
  selectedTargetKeys,
  focusFiles,
  canInteractWithNode,
  changedSubtrees,
  showAllContext,
  collapsedPaths,
  fileBoundaryPaths,
  onToggleNode,
}: CallFlowNodeRowProps) {
  // Complete CallDiff trees can contain thousands of unchanged context nodes.
  // Keep every subtree available, but only open paths that lead to an actual
  // change by default. This preserves the full result without mounting the
  // entire inferred graph into the DOM up front.
  const expanded = !collapsedPaths.has(treePath);
  const hasChildren = showAllContext
    ? node.children.length > 0
    : node.children.some((child) => changedSubtrees.has(child));
  const inPatch = canInteractWithNode?.(node) ?? true;
  const navigable = Boolean(node.file && node.line && inPatch);
  const annotationTarget = annotationTargetForCallFlowNode(node, entry, treePath);
  const annotatable = Boolean(onAnnotate && annotationTarget);
  const selected = selectedTargetKeys.has(treePath);
  const focused = node.status !== 'same' && Boolean(node.file && focusFiles?.has(node.file));
  const path = node.file ? splitCallFlowFilePath(node.file) : null;
  const startsFileSection = Boolean(path && fileBoundaryPaths.has(treePath));
  const location = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '';
  const targetTitle = annotatable
    ? `${inPatch ? `Comment on ${node.label}.` : `Comment on ${node.label} as Call Flow feedback.`} Shift-click to add or remove this step from the open comment.`
    : navigable
      ? `Open ${location}`
      : node.file && node.line
        ? 'Outside the reviewed patch'
        : node.label;

  return (
    <li className="call-flow-node">
      {startsFileSection && path && node.file && (
        <div
          className="call-flow-file-boundary"
          style={{ '--call-flow-depth': depth } as React.CSSProperties}
          aria-label={`File boundary: ${node.file}`}
          title={node.file}
        >
          <span className="call-flow-file-boundary-label">File</span>
          <span className="call-flow-file-boundary-name">{path.name}</span>
          {path.directory && (
            <span className="call-flow-file-boundary-directory">{path.directory}</span>
          )}
        </div>
      )}
      <div
        className={`call-flow-row call-flow-row-${node.status}${focused ? ' call-flow-row-focused' : ''}${annotatable ? ' call-flow-row-selectable' : ''}${selected ? ' call-flow-row-selected' : ''}`}
        style={{ '--call-flow-depth': depth } as React.CSSProperties}
        data-call-flow-target={treePath}
      >
        {hasChildren ? (
          <button
            type="button"
            className="call-flow-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.label}`}
            aria-expanded={expanded}
            onClick={() => onToggleNode(treePath)}
          >
            <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
          </button>
        ) : (
          <span className="call-flow-expand" aria-hidden="true" />
        )}
        <span className={`call-flow-status call-flow-status-${node.status}`} aria-label={node.status}>
          {statusGlyph(node.status)}
        </span>
        <button
          type="button"
          className="call-flow-node-target"
          disabled={!annotatable && !navigable}
          aria-pressed={annotatable ? selected : undefined}
          onClick={(event) => {
            if (annotatable && annotationTarget && onAnnotate) {
              const anchor = event.currentTarget.parentElement ?? event.currentTarget;
              onAnnotate(annotationTarget, anchor, event.shiftKey);
              return;
            }
            if (navigable) onOpen(node);
          }}
          title={targetTitle}
        >
          <span className="call-flow-node-label">{node.label}</span>
          {node.kind === 'branch' && <span className="call-flow-node-kind">branch</span>}
        </button>
        {path && node.line ? (
          <button
            type="button"
            className="call-flow-node-location"
            disabled={!navigable}
            onClick={() => onOpen(node)}
            title={navigable ? `Open ${location}` : 'Outside the reviewed patch'}
            aria-label={navigable ? `Open ${location}` : `Source ${location} is outside the reviewed patch`}
          >
            <span className="call-flow-node-location-main">
              <span className="call-flow-node-file">{path.name}</span>
              <span className="call-flow-node-line">:{node.line}</span>
            </span>
            {path.directory && <span className="call-flow-node-directory">{path.directory}</span>}
          </button>
        ) : (
          <span className="call-flow-node-location-placeholder" aria-hidden="true" />
        )}
      </div>
      {hasChildren && expanded && (
        <ol className="call-flow-children">
          {node.children.map((child, index) => (
            !showAllContext && !changedSubtrees.has(child) ? null : (
              <CallFlowNodeRow
                key={`${treePath}/${child.key}:${child.status}:${index}`}
                node={child}
                entry={entry}
                depth={depth + 1}
                treePath={`${treePath}/${child.key}:${index}`}
                onOpen={onOpen}
                onAnnotate={onAnnotate}
                selectedTargetKeys={selectedTargetKeys}
                focusFiles={focusFiles}
                canInteractWithNode={canInteractWithNode}
                changedSubtrees={changedSubtrees}
                showAllContext={showAllContext}
                collapsedPaths={collapsedPaths}
                fileBoundaryPaths={fileBoundaryPaths}
                onToggleNode={onToggleNode}
              />
            )
          ))}
        </ol>
      )}
    </li>
  );
}

interface CallFlowTreeViewProps {
  readonly trees: readonly CallFlowTree[];
  readonly onOpenNode: (node: CallFlowNode) => void;
  /** Commit one source-backed annotation through the native review model. */
  readonly onAnnotateTargets?: (
    targets: readonly CallFlowAnnotationTarget[],
    text: string,
  ) => boolean;
  /** Changed rows in these files receive the Lens focus treatment. */
  readonly focusFiles?: readonly string[];
  /** Gate navigation and comments to ranges represented by the active patch. */
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  /** Notify a containing popover while the multi-target composer is open. */
  readonly onAnnotationDraftChange?: (active: boolean) => void;
  readonly compact?: boolean;
}

function CallFlowEntrySection({
  entry,
  index,
  changedCount,
  changedSubtrees,
  showAllContext,
  onOpenNode,
  onAnnotate,
  selectedTargetKeys,
  focused,
  canInteractWithNode,
  collapsedPaths,
  fileBoundaryPaths,
  onToggleNode,
}: {
  readonly entry: CallFlowTree;
  readonly index: number;
  readonly changedCount: number;
  readonly changedSubtrees: ReadonlySet<CallFlowNode>;
  readonly showAllContext: boolean;
  readonly onOpenNode: (node: CallFlowNode) => void;
  readonly onAnnotate?: CallFlowNodeRowProps['onAnnotate'];
  readonly selectedTargetKeys: ReadonlySet<string>;
  readonly focused?: ReadonlySet<string>;
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  readonly collapsedPaths: ReadonlySet<string>;
  readonly fileBoundaryPaths: ReadonlySet<string>;
  readonly onToggleNode: (treePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(index === 0);
  const treePath = `${entry.entry}:${index}`;
  return (
    <section className="call-flow-entry">
      <button
        type="button"
        className="call-flow-entry-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="call-flow-entry-mark" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
        <span className="call-flow-entry-label">{entry.entry}</span>
        <span className="call-flow-entry-meta">
          {changedCount.toLocaleString()} changed · entry path
        </span>
      </button>
      {expanded && (
        <ol className="call-flow-tree">
          <CallFlowNodeRow
            node={entry.tree}
            entry={entry.entry}
            depth={0}
            treePath={treePath}
            onOpen={onOpenNode}
            onAnnotate={onAnnotate}
            selectedTargetKeys={selectedTargetKeys}
            focusFiles={focused}
            canInteractWithNode={canInteractWithNode}
            changedSubtrees={changedSubtrees}
            showAllContext={showAllContext}
            collapsedPaths={collapsedPaths}
            fileBoundaryPaths={fileBoundaryPaths}
            onToggleNode={onToggleNode}
          />
        </ol>
      )}
    </section>
  );
}

/** Shared complete-tree renderer used by both the Dock and the per-file Lens. */
export function CallFlowTreeView({
  trees,
  onOpenNode,
  onAnnotateTargets,
  focusFiles,
  canInteractWithNode,
  onAnnotationDraftChange,
  compact = false,
}: CallFlowTreeViewProps) {
  const focused = useMemo(() => focusFiles ? new Set(focusFiles) : undefined, [focusFiles]);
  const treeShape = useMemo(() => {
    const nodes = new Set<CallFlowNode>();
    const entryChangedCounts = new Map<CallFlowTree, number>();
    let totalNodes = 0;
    const visit = (node: CallFlowNode): { containsChange: boolean; changedCount: number } => {
      totalNodes += 1;
      let containsChange = node.status !== 'same';
      let changedCount = node.status === 'same' ? 0 : 1;
      for (const child of node.children) {
        const childResult = visit(child);
        if (childResult.containsChange) containsChange = true;
        changedCount += childResult.changedCount;
      }
      if (containsChange) nodes.add(node);
      return { containsChange, changedCount };
    };
    for (const tree of trees) {
      entryChangedCounts.set(tree, visit(tree.tree).changedCount);
    }
    return {
      changedSubtrees: nodes as ReadonlySet<CallFlowNode>,
      entryChangedCounts: entryChangedCounts as ReadonlyMap<CallFlowTree, number>,
      totalNodes,
    };
  }, [trees]);
  const { changedSubtrees, entryChangedCounts, totalNodes } = treeShape;
  const hiddenContextNodes = totalNodes - changedSubtrees.size;
  const [showAllContext, setShowAllContext] = useState(false);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setCollapsedPaths(new Set());
  }, [trees]);
  const toggleNode = useCallback((treePath: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(treePath)) next.delete(treePath);
      else next.add(treePath);
      return next;
    });
  }, []);
  const fileBoundaryPaths = useMemo<ReadonlySet<string>>(() => {
    const boundaries = new Set<string>();
    for (const [entryIndex, entry] of trees.entries()) {
      let previousFile: string | undefined;
      const visit = (node: CallFlowNode, treePath: string) => {
        if (node.file && node.file !== previousFile) boundaries.add(treePath);
        if (node.file) previousFile = node.file;
        if (collapsedPaths.has(treePath)) return;
        node.children.forEach((child, childIndex) => {
          if (!showAllContext && !changedSubtrees.has(child)) return;
          visit(child, `${treePath}/${child.key}:${childIndex}`);
        });
      };
      visit(entry.tree, `${entry.entry}:${entryIndex}`);
    }
    return boundaries;
  }, [changedSubtrees, collapsedPaths, showAllContext, trees]);
  const treeInstanceId = useId();
  const [draftTargets, setDraftTargets] = useState<CallFlowAnnotationTarget[]>([]);
  const [refocusToken, setRefocusToken] = useState(0);
  const [composerYield, setComposerYield] = useState<ComposerYieldState>('none');
  const composerYieldRef = useRef(composerYield);
  composerYieldRef.current = composerYield;
  const shiftHeldRef = useRef(false);
  const primaryTargetKeyRef = useRef<string | undefined>(undefined);
  primaryTargetKeyRef.current = draftTargets[0]
    ? `${treeInstanceId}:${draftTargets[0].treePath}`
    : undefined;
  const targetElements = useRef(new Map<string, HTMLElement>());
  const selectedTargetKeys = useMemo(
    () => new Set(draftTargets.map((target) => target.treePath)),
    [draftTargets],
  );
  const anchorEl = draftTargets[0]
    ? targetElements.current.get(draftTargets[0].treePath)
    : undefined;

  const handleYieldPointer = useCallback((clientX: number, clientY: number) => {
    if (!shiftHeldRef.current) return;
    const popover = Array.from(document.querySelectorAll('[data-comment-popover]')).find((candidate) => (
      candidate.querySelector('[data-target-chip-primary="true"]')?.getAttribute('data-target-chip')
        === primaryTargetKeyRef.current
    ));
    if (!popover) return;
    const next = computeComposerYield(
      composerYieldRef.current,
      distanceToRect(clientX, clientY, popover.getBoundingClientRect()),
    );
    if (next !== composerYieldRef.current) setComposerYield(next);
  }, []);

  useEffect(() => {
    if (draftTargets.length === 0) {
      shiftHeldRef.current = false;
      setComposerYield('none');
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shiftHeldRef.current = true;
    };
    const release = () => {
      shiftHeldRef.current = false;
      setComposerYield('none');
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') release();
    };
    const onMouseMove = (event: MouseEvent) => {
      if (event.shiftKey) shiftHeldRef.current = true;
      handleYieldPointer(event.clientX, event.clientY);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, [draftTargets.length, handleYieldPointer]);

  const replaceDraft = (next: CallFlowAnnotationTarget[]) => {
    const wasActive = draftTargets.length > 0;
    const active = next.length > 0;
    setDraftTargets(next);
    if (wasActive !== active) onAnnotationDraftChange?.(active);
  };

  const selectTarget = (
    target: CallFlowAnnotationTarget,
    anchor: HTMLElement,
    extend: boolean,
  ) => {
    targetElements.current.set(target.treePath, anchor);
    if (!extend || draftTargets.length === 0) {
      replaceDraft([target]);
      return;
    }
    const existingIndex = draftTargets.findIndex((candidate) => candidate.treePath === target.treePath);
    const next = existingIndex === -1
      ? [...draftTargets, target]
      : draftTargets.filter((_, index) => index !== existingIndex);
    replaceDraft(next);
    setRefocusToken((token) => token + 1);
  };

  const removeTarget = (chipKey: string) => {
    replaceDraft(draftTargets.filter((target) => `${treeInstanceId}:${target.treePath}` !== chipKey));
    setRefocusToken((token) => token + 1);
  };

  const targetChips = useMemo<CommentTargetChip[]>(() => draftTargets.map((target) => {
    const sourceLabel = target.filePath
      ? `${splitCallFlowFilePath(target.filePath).name}${target.lineStart ? `:${target.lineStart}` : ''}`
      : 'inferred step';
    return {
      key: `${treeInstanceId}:${target.treePath}`,
      label: sourceLabel,
      excerpt: `${target.entry} → ${target.label}`,
    };
  }), [draftTargets, treeInstanceId]);

  return (
    <>
      <div className={`call-flow-trees${compact ? ' call-flow-trees-compact' : ''}`}>
        {hiddenContextNodes > 0 && (
          <div className="call-flow-context-control">
            <span>
              {showAllContext
                ? `${totalNodes.toLocaleString()} inferred steps`
                : `${hiddenContextNodes.toLocaleString()} unchanged context steps hidden`}
            </span>
            <button
              type="button"
              aria-pressed={showAllContext}
              onClick={() => setShowAllContext((visible) => !visible)}
            >
              {showAllContext ? 'Show changed paths' : 'Show all context'}
            </button>
          </div>
        )}
        {trees.map((entry, index) => (
          <CallFlowEntrySection
            key={`${entry.entry}:${index}`}
            entry={entry}
            index={index}
            changedCount={entryChangedCounts.get(entry) ?? 0}
            changedSubtrees={changedSubtrees}
            showAllContext={showAllContext}
            onOpenNode={onOpenNode}
            onAnnotate={onAnnotateTargets ? selectTarget : undefined}
            selectedTargetKeys={selectedTargetKeys}
            focused={focused}
            canInteractWithNode={canInteractWithNode}
            collapsedPaths={collapsedPaths}
            fileBoundaryPaths={fileBoundaryPaths}
            onToggleNode={toggleNode}
          />
        ))}
      </div>
      {onAnnotateTargets && anchorEl && draftTargets.length > 0 && (
        <CommentPopover
          anchorEl={anchorEl}
          contextText={`${draftTargets[0].entry} → ${draftTargets[0].label}`}
          isGlobal={false}
          allowImages={false}
          targetChips={targetChips}
          onRemoveTargetChip={removeTarget}
          refocusToken={refocusToken}
          captureStrayKeys
          yieldState={composerYield}
          onSubmit={(text) => {
            if (onAnnotateTargets(draftTargets, text)) replaceDraft([]);
          }}
          onClose={() => replaceDraft([])}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {draftTargets.length > 0
          ? `${draftTargets.length} call-flow ${draftTargets.length === 1 ? 'step' : 'steps'} selected.`
          : ''}
      </span>
    </>
  );
}
