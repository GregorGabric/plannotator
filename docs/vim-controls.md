# Vim controls

Vim controls provide optional, fully keyboard-driven Select and Pinpoint
annotation in the plan and annotate applications.

## Goal

- Add an opt-in Vim mode setting. It must default to off.
- Offer a second, separately opt-in HUD that visualizes only handled Vim
  commands.
- Preserve every existing pointer and keyboard interaction when Vim mode is
  off.
- Support keyboard navigation and annotation in both Select and Pinpoint.
- Support Markdown and raw-HTML documents.
- Route keyboard-created annotations through the same annotation pipeline as
  pointer-created annotations.
- Make the rendered document's semantic structure—not DOM focus—the primary
  navigation model.
- Use one semantic target graph for pointer Pinpoint and keyboard navigation.
- Cover the behavior with automated tests against representative documents.

## Compatibility invariants

1. Vim mode is disabled for every existing user unless they explicitly enable
   it.
2. With Vim mode disabled, no Vim key handler may consume or alter an
   unmodified key.
3. Vim commands never run while focus is in an input, textarea, contenteditable
   region, dialog, annotation composer, label picker, image editor, or another
   embedded editor.
4. `Tab` and `Shift+Tab` keep their native focus-navigation behavior.
5. Pointer Select, pointer Pinpoint, Alt-hold, and Alt-double-tap continue to
   work as they do today.
6. Keyboard selection must create the same annotation data and highlight DOM
   as the corresponding pointer selection.
7. Escape unwinds only the innermost active Vim/annotation state.

## Intended interaction

### Navigation model

`DOCUMENT → BLOCK → INLINE TARGET → TEXT → VISUAL SELECTION`

- Activating Vim controls enters **BLOCK** at the semantic block nearest the
  viewport: a paragraph, heading, list item, code block, table, and so on.
- `j` / `k`: next or previous block; after refining, next or previous
  semantic sibling (for example, another table row, cell, or inline target).
- `gg` / `G`: first or last block.
- `l`: refine into a child target; from the deepest target, enter text.
- `h`: return to the containing target.
- `v`: begin or end characterwise Visual selection.
- `V`: select the whole current block; `j` / `k` extend by whole blocks.
- In text, `h` / `l`, `w` / `b` / `e`, `0` / `$`, and `j` / `k` use precise
  caret motions.
- `o`: swap the fixed and moving ends of a selection.
- `Escape`: back out exactly one level.

The document element may own technical keyboard focus, but it is never drawn
as the active target. BLOCK and INLINE use the existing Pinpoint wash and
label around the exact semantic element. TEXT uses a caret. VISUAL and VISUAL
BLOCK use the browser selection. The compact status badge reports BLOCK,
INLINE, NORMAL, VISUAL, VISUAL BLOCK, or ACTION. Users who additionally enable
**Vim HUD** get the same information in a larger bottom-right command display:
recent handled keys, the active navigation granularity, the input method, and
a contextual action description. The HUD uses the same component and styling
for Markdown and raw HTML.

Pointer Pinpoint and keyboard navigation resolve through the same canonical
graph, which owns target identity, hierarchy, labels, annotation ranges, and
overlay elements. Table rows, cells, and inline formatting remain keyboard
reachable: `l` enters a level, `j` / `k` move among siblings, and `h` returns
to the parent before block navigation resumes.

### Actions

- `Enter`: use the active Markup, Comment, Redline, or Label mode.
- `Space`: open the existing annotation action toolbar.
- `c`: comment.
- `d`: redline/delete.
- `m`: markup.
- `t`: label.
- `y`: copy.
- `Escape`: cancel one layer.
- `?`: show contextual help.

Annotation actions apply to BLOCK/INLINE targets or an active VISUAL range.
In NORMAL text state, first create a range with `v`; a collapsed caret is not
silently promoted to the whole containing block.

## Architecture

Markdown documents use a canonical semantic target graph shared by pointer
Pinpoint and keyboard navigation. It owns block order, hierarchy, labels,
annotation ranges, and overlay elements. Text positions are serialized as a
block ID plus a text offset, so cursor and Visual state survive highlight DOM
mutations without retaining stale text nodes.

Keyboard-created ranges enter the same `@plannotator/web-highlighter`
`fromRange()` pipeline as pointer selections. Code blocks and formulas retain
their specialized annotation paths. Raw HTML keeps its range and focus state
inside the sandboxed iframe, then posts through the existing, source-validated
annotation bridge.

Vim controls are cookie-persisted, default off, and scoped to the focused
document. No global letter-key listener is installed. Disabling the setting
removes the document focus surface and leaves existing behavior unchanged.
Vim HUD is independently cookie-persisted, default off, and only records or
renders commands while enabled. Text entered into annotation composers is
neither captured nor displayed.
