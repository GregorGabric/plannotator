import { defineShortcutScope } from '../core';

/** The one-line "Add a note" field on the annotate Send control. Enter sends
 * (deliberately NOT Mod+Enter — the field is one line, so a bare Enter has no
 * other job and the whole point of the affordance is one interaction). The
 * handlers are local to the input; this scope exists so the chords show up in
 * the in-app help modal and the generated docs, the same way the comment
 * editor's chords do. */
export const annotateNoteShortcuts = defineShortcutScope({
  id: 'annotate-note',
  title: 'Quick Note',
  shortcuts: {
    submit: {
      description: 'Send the note with your annotations',
      bindings: ['Enter'],
      section: 'Actions',
      hint: 'Available while the Send control’s note field is open.',
      displayOrder: 12,
    },
    cancel: {
      description: 'Close the note field without sending',
      bindings: ['Escape'],
      section: 'Actions',
      hint: 'The typed note is kept for the rest of the session but is not sent.',
      displayOrder: 14,
    },
  },
});
