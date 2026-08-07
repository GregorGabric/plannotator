import { defineShortcutScope } from '../core';

export const commentPopoverShortcuts = defineShortcutScope({
  id: 'comment-popover',
  title: 'Comment Editor',
  shortcuts: {
    submit: {
      description: 'Submit comment',
      bindings: ['Mod+Enter'],
      section: 'Annotations',
      displayOrder: 30,
    },
    cancel: {
      description: 'Close comment',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while the comment editor is open.',
      displayOrder: 40,
    },
    skillMenuOpen: {
      description: 'Reference an agent skill (opens the skill menu)',
      bindings: ['/', '$'],
      section: 'Annotations',
      hint: 'Type at the start of a word in the comment editor. Escape dismisses the menu; Enter inserts the highlighted skill.',
      displayOrder: 50,
    },
  },
});
