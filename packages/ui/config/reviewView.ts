import { configStore } from './configStore';

/**
 * The ONLY writers for the coupled setting pair (reviewPanelView,
 * defaultDiffType).
 *
 * Invariant: the Sections (Git status) view can only render the since-base
 * diff. So:
 *   - choosing the sections view forces defaultDiffType = 'since-base'
 *   - choosing a non-since-base default diff snaps the view to 'tree'
 *   - tree + since-base IS valid — switching to Tree leaves the diff, and
 *     choosing since-base leaves the view
 *
 * Hand-mirroring these rules at call sites is how the split-brain bug
 * happened (a writer persisted one half of the pair; configStore.init()
 * then re-corrupted it from the server every session). Never write either
 * setting directly — always go through these setters. configStore.init()
 * remains the one non-writer that can produce a conflicted pair from a
 * stale config.json; the App-level load reconciler heals that case by
 * calling setReviewPanelView('sections').
 */
export function setReviewPanelView(view: 'sections' | 'tree'): void {
  configStore.set('reviewPanelView', view);
  // An explicit persisted choice also becomes the last-used view — otherwise
  // a stale last-used cookie would immediately shadow what the user just
  // picked in Settings / the setup dialog.
  configStore.set('reviewPanelViewLastUsed', view);
  if (view === 'sections' && configStore.get('defaultDiffType') !== 'since-base') {
    configStore.set('defaultDiffType', 'since-base');
  }
}

export type ReviewDefaultDiffType =
  | 'since-base'
  | 'uncommitted'
  | 'unstaged'
  | 'staged'
  | 'merge-base'
  | 'all';

export function setReviewDefaultDiffType(value: ReviewDefaultDiffType): void {
  configStore.set('defaultDiffType', value);
  if (value !== 'since-base' && configStore.get('reviewPanelView') !== 'tree') {
    configStore.set('reviewPanelView', 'tree');
    configStore.set('reviewPanelViewLastUsed', 'tree');
  }
}
