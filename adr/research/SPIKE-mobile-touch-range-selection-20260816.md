# Mobile touch range selection spike

**Status:** prototype ready for physical-device gate

**Branch:** `codex/mobile-touch-selection`

**Baseline:** `origin/main` at `eb6a59e2dc6e418c1c4ed7830ee210091d754061`
**Surfaces:** Markdown Plan Review and Pierre-backed Code Review

## Why this exists

The shipped mobile foundation makes a single Plan block or diff line practical to annotate, but extending that target still depends on a desktop-shaped gesture:

- Safari text selection is the only way to span multiple Plan blocks in Drag mode. It raises the native Copy / Find Selection UI and can prevent Plannotator's own actions from receiving the next tap.
- Pierre can technically drag a line-number selection with Pointer Events, but a vertical gutter drag competes with the phone's primary scroll gesture. A reliable comment range must not depend on that gesture.

The goal is a touch-native way to choose one contiguous range. It is not a new annotation model and it is not a general-purpose mobile text editor.

## Method

1. Trace the existing acquisition, preview, draft, commit, restore, and export paths before introducing state.
2. Reuse the canonical range already accepted by each annotation pipeline.
3. Keep selection separate from text entry: choosing or adjusting a target must not focus a textarea or summon the software keyboard.
4. Gate new composition behind the shared compact-touch predicate: `(max-width: 1024px) and (pointer: coarse)`.
5. Treat desktop fine-pointer behavior as a control. Existing click, drag, keyboard, toolbar, and composer behavior must remain unchanged.
6. Use rendered browser checks as preflight and physical iPhone/iPad Safari as the release authority.

## Existing contracts

### Plan Review

`usePinpoint` resolves taps through the same ordered `SemanticTargetGraph` used by Vim navigation. `useAnnotationHighlighter` already accepts a DOM `Range` that can cross block boundaries, and web-highlighter serializes one source with start/end metadata. Comments, redlines, drafts, export, reload restoration, and sidebar navigation therefore do not need a second annotation schema for a contiguous block span.

The missing seam is acquisition. Today Pinpoint is disabled as soon as its first selection opens a toolbar or composer.

### Code Review

`SelectedLineRange` already represents a multi-line target. `useAnnotationToolbar` extracts the selected code and commits the same start/end span, while both `DiffViewer` and `AllFilesCodeView` project `pendingSelection` back into Pierre as a controlled selection.

Pierre's current interaction manager already uses Pointer Events and supports a gutter drag. The missing seam is a non-drag alternative. This can be implemented in Plannotator's wrapper and hook state; it does not require changing Pierre, its Shadow DOM, or its selection types.

## Shared interaction model

Both surfaces use an explicit two-step adjustment:

1. The user's current single target becomes the fixed anchor.
2. The user invokes a local **Extend** / **Adjust lines** action.
3. The active editor/composer yields without discarding its draft. A small, safe-area-aware instruction surface says what to tap and offers Cancel.
4. The next eligible target in the same document or file becomes the other endpoint.
5. Plannotator previews the normalized contiguous range and returns to the prior toolbar/composer.

This is intentionally endpoint selection, not tap-to-toggle arbitrary items. Contiguous ranges preserve document meaning, produce readable exported context, and fit the existing durable annotation records. Discontiguous targets remain a separate product question; raw HTML's multi-target model is not silently generalized to Markdown.

## Plan prototype: block endpoint selection

Eligibility:

- compact-touch layout;
- Pinpoint input method;
- ordinary text-bearing semantic targets in the same rendered Markdown document;
- a pending selection toolbar exists.

Flow:

1. Tap a paragraph or list item in Pinpoint.
2. Tap **Extend** in the selection toolbar.
3. The toolbar yields; the original highlight stays as the anchor.
4. Scroll normally and tap the last paragraph or list item.
5. A DOM range is built from the first boundary of the earlier block to the last boundary of the later block, regardless of tap direction.
6. The ordinary toolbar returns over the combined highlight. Comment, delete, quick-label, copy, cancel, draft, submit, and reload paths remain incumbent.

First-prototype limits:

- one contiguous range;
- text blocks only as endpoints; code, math, tables, and raw HTML keep their specialized selection paths;
- adjustment begins from the selection toolbar, before the comment composer opens;
- changing documents or leaving Pinpoint cancels adjustment and restores the original pending target.

## Code Review prototype: line endpoint selection

Eligibility:

- compact-touch layout;
- a new line comment draft, not an existing annotation edit or token-only annotation;
- an active file and an ordinary line range.

Flow:

1. Select a line and begin a comment as today.
2. Tap **Adjust lines** beside the range title.
3. The composer yields without saving, clearing, or focusing anything. A compact instruction surface says **Tap the last line** and offers Cancel.
4. Tap a line number in the same file. Plannotator combines that endpoint with the original anchor and updates Pierre through controlled `selectedLines`.
5. The same draft composer returns with its text, labels, decorations, suggestion state, and caret data intact. The title reflects the new range.

First-prototype limits:

- same file only;
- same diff side only, matching the annotation/export model's single-side original-code extraction;
- no range adjustment while editing an existing submitted annotation;
- no attempt to replace Pierre's existing mouse/trackpad drag or Shift extension.

## State and cancellation rules

- The committed selection is not changed until a valid endpoint is tapped.
- Cancel returns to the prior toolbar/composer with its original range and draft.
- Escape performs the same cancellation when a hardware keyboard is present.
- Device rotation and visual-viewport changes preserve adjustment state.
- Changing the active Plan document, review file, diff family, or edit session cancels adjustment.
- A tap on an ineligible endpoint does not discard the draft and does not create a partial range.
- Starting adjustment never opens the software keyboard. Returning to the composer does not auto-focus on a coarse pointer.

## Visual and accessibility contract

- The anchor and candidate range use existing selection colors; no new permanent document chrome is introduced.
- The temporary instruction surface is above Safari's home-indicator inset and never owns page scrolling.
- Actions are at least 44 by 44 CSS pixels in compact touch layout.
- Status text is announced through a polite live region.
- Color is not the only state indicator: the instruction text and range label identify adjustment mode.
- Reduced-motion mode removes any yield/re-entry transition.

## Desktop non-regression contract

At a fine primary pointer, the new props and state are inert:

- Plan Pinpoint and Drag selection behave exactly as on `origin/main`.
- Pierre line-number drag, Shift extension, mouse selection, hover utility, split/unified rendering, and keyboard shortcuts are unchanged.
- Toolbar and composer geometry are unchanged.
- No media query uses `any-pointer: coarse`.

## Validation matrix

Automated coverage:

- range normalization in forward and reverse document order;
- Plan cancellation, invalid target, mode/document change, and source replacement;
- Code Review draft preservation, same-side range combination, invalid side/file, cancellation, and controlled-selection projection;
- compact-touch gate on a phone/iPad profile and inert behavior on narrow fine-pointer and hybrid-primary-mouse profiles;
- no focus call during adjustment.

Rendered preflight:

- 320 x 568 and 390 x 844 compact phone profiles;
- 768 x 1024 iPad portrait and 1024 x 768 iPad landscape;
- 1280 x 720 and 1440 x 900 desktop controls;
- long plans, long diffs, a range that starts below the fold, and rotation while adjusting.

Physical gate:

- iPhone Safari: browser chrome collapses while scrolling during adjustment; no native selection menu or magnifier appears; the keyboard stays closed until the user taps the textarea.
- iPad Safari: finger and trackpad paths both remain usable; trackpad behavior does not inherit the compact touch composition when it is the primary pointer.
- Code Review: selection remains painted after the composer returns and the submitted annotation spans the intended lines after reload.

## Decision after the prototype

The prototype passes only if endpoint selection is faster and less error-prone than native drag on a physical phone, without making single-target comments slower. If the explicit adjustment action feels too hidden, the next experiment is a temporary selection handle/pill after the first tap—not a persistent new top-level mode and not native text selection.

## Implemented prototype evidence

- Plan compact Pinpoint replaces the pending toolbar's Copy slot with **Extend selection**. The endpoint tap produces one forward whole-block range, anchors the returned toolbar at the endpoint that is currently visible, and leaves `window.getSelection()` collapsed.
- Code Review adds **Adjust lines** only to a compact-touch, new line-comment draft. The composer yields to a safe-area-aware instruction pill, preserves the live draft, combines a same-side endpoint, and returns on the updated range. All Files refuses a cross-file switch during adjustment.
- The shared instruction surface owns no scroll container and supports a 44px Cancel action plus Escape.
- 20 focused tests pass, including rendered Plan multi-block selection, narrow fine-pointer exclusion, Code Review draft preservation, range normalization, touch target markers, and mobile dialog composition.
- Root typecheck passes. Both production single-file builds pass: `apps/review` and `apps/hook`.
- In-app rendered checks at 390 x 844 and 1280 x 720 confirm the fine-primary-pointer controls remain unchanged. The in-app browser cannot emulate a coarse primary pointer, so physical Safari remains the authority for the new composition.
