# Mobile touch range selection spike

**Status:** explicit endpoint-command prototype rejected; direct-manipulation exploration in progress

**Branch:** `codex/mobile-touch-selection`

**Baseline:** `origin/main` at `eb6a59e2dc6e418c1c4ed7830ee210091d754061`
**Surfaces:** Markdown Plan Review and Pierre-backed Code Review

## Why this exists

The shipped mobile foundation makes a single Plan block or diff line practical to annotate, but extending that target still depends on a desktop-shaped gesture:

- Safari text selection is the only way to span multiple Plan blocks in Drag mode. It raises the native Copy / Find Selection UI and can prevent Plannotator's own actions from receiving the next tap.
- Pierre can technically drag a line-number selection with Pointer Events, but a vertical gutter drag competes with the phone's primary scroll gesture. A reliable comment range must not depend on that gesture.

The goal is a touch-native way to choose one contiguous range. It is not a new annotation model and it is not a general-purpose mobile text editor.

## Product feedback that changed the direction

The first prototype's **Extend selection** and **Adjust lines** commands are rejected. They add a mode switch between the initial target and the actual range gesture, making the interaction slower and less physical than the thing it replaces. This is not a copy or presentation problem; the command-mediated model itself is wrong.

The next experiments must satisfy a stronger contract:

- no preparatory command before extending a range;
- continuous visual feedback while the finger moves;
- release commits the target and exposes the normal annotation actions;
- ordinary scrolling remains available outside the active selection affordance;
- Plan and Code Review may use different acquisition gestures because their content models are different.

## What the platform actually provides

### Safari-native text selection

Safari owns long-press text selection, its draggable leading/trailing handles, magnifier, and Copy / Find callout. The web Selection API lets Plannotator observe and preserve the resulting range through `selectionchange`, but it exposes no selection-handle UI and no supported extension point for adding Plannotator actions to Safari's callout.

`-webkit-touch-callout: none` is a non-standard Safari control for the long-press callout. It is not evidence that system selection handles will remain usable, and WebKit has version-specific long-press/loupe behavior. Any combination of native handles, suppressed callout, and custom Plannotator actions therefore requires a physical-Safari experiment rather than a code-only conclusion.

Primary evidence:

- [W3C Selection API](https://www.w3.org/TR/selection-api/) defines the document selection, `selectstart`, and `selectionchange`; it does not expose system handles or menu customization.
- [W3C Pointer Events](https://www.w3.org/TR/pointerevents/) states that `touch-action` governs browser panning/zooming, not text selection or highlighting.
- [Apple Safari CSS reference](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariCSSRef/Articles/StandardCSSProperties.html) documents `-webkit-touch-callout` as a Safari-specific callout switch.
- [WebKit bug 231161](https://bugs.webkit.org/show_bug.cgi?id=231161) distinguishes text selection (`user-select`) from long-press callout/loupe behavior and demonstrates why version-qualified device testing is required.

### Pierre line-range selection

`@pierre/diffs` 1.3.2 already provides the desired direct gesture. A pointer down in the line-number column seeds a range, document-level Pointer Events track across rows, the painted selection updates continuously, and pointer up emits `onLineSelectionEnd`. The gutter is already `user-select: none` and `touch-action: none`, so this path neither invokes native text selection nor hands the active drag to page scrolling.

Plannotator already sets `enableLineSelection: true` and routes `onLineSelectionEnd` into the existing annotation toolbar in both File and All Files views. The remaining Code Review problem is therefore discoverability and touch geometry, not range state or a missing interaction engine.

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

Pierre's current interaction manager already uses Pointer Events and supports a gutter drag. The rejected prototype incorrectly treated a non-drag alternative as the missing seam. The next spike should preserve Pierre's direct gesture and improve its compact-touch affordance and hit geometry without changing its range types.

## Rejected shared interaction model

The first prototype used an explicit two-step adjustment:

1. The user's current single target becomes the fixed anchor.
2. The user invokes a local **Extend** / **Adjust lines** action.
3. The active editor/composer yields without discarding its draft. A small, safe-area-aware instruction surface says what to tap and offers Cancel.
4. The next eligible target in the same document or file becomes the other endpoint.
5. Plannotator previews the normalized contiguous range and returns to the prior toolbar/composer.

This was intentionally endpoint selection rather than tap-to-toggle arbitrary items. Its data model was sound, but its interaction was not ergonomic enough to continue. The implementation remains useful as evidence that both annotation pipelines already accept contiguous ranges; it is not the proposed UI.

## Direct-manipulation experiments

### Code Review — first candidate

Use Pierre's incumbent line-number drag directly:

1. Touch a line number and begin dragging in one motion.
2. Paint the selected range 1:1 under the finger as it crosses rows.
3. Release to open the normal feedback composer for that range.

The experiment should enlarge the compact-touch hit region to at least 44 CSS pixels without unnecessarily widening the visible gutter or reducing the code viewport. It must test vertical page-scroll intent near the gutter, horizontal code scrolling, split and unified sides, reverse drag, edge auto-scroll, and a simple tap for a single-line comment. No new button or persistent instruction is permitted.

### Plan — candidate A: native range, actions out of the way

1. Long-press text and use Safari's own handles to select the desired words or blocks.
2. Preserve the live range from `selectionchange`.
3. Present Plannotator annotation actions in a safe-area-aware bottom dock, spatially separate from Safari's selection callout.
4. Capture the saved range on action pointer-down so Safari collapsing the visible selection does not lose the target.

This candidate wins if native handles can be extended across rendered Markdown and the bottom actions remain tappable without disabling ordinary copy, lookup, accessibility, or scrolling. Suppressing Safari's callout is an optional experimental cell, not the default assumption.

### Plan — candidate B: semantic range handles

1. A normal Pinpoint tap selects one semantic block as today.
2. The selected range exposes a direct trailing handle; there is no **Extend** command.
3. Dragging that handle over another semantic block continuously expands or contracts the contiguous range.
4. Edge proximity auto-scrolls the document while the handle remains attached to the finger.
5. Releasing returns the ordinary annotation toolbar at the visible endpoint.

Only the handle owns `touch-action: none`; the document keeps native vertical scrolling everywhere else. This is custom web UI, but it borrows the familiar leading/trailing-handle model and maps the finger directly to the selected extent.

Candidate B is preferred over a whole-document drag recognizer because taking over a vertical drag anywhere in Plan would conflict with its primary reading/scrolling gesture. A hold-then-drag recognizer is also lower priority because it competes with Safari's long-press selection and introduces a disambiguation delay.

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
