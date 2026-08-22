import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { APIRoute } from 'astro';

// Serve the plannotator knowledge skill as /llms.txt (https://llmstxt.org/).
// Single-sourced at build time from the skill file, so the CLI freshness
// guard in apps/hook/server/plannotator-skill-reference.test.ts transitively
// protects this page from drifting: if the skill is current, so is llms.txt.
const SKILL_PATH = resolve(process.cwd(), '../../apps/skills/core/plannotator/SKILL.md');

function buildLlmsTxt(): string {
  const raw = readFileSync(SKILL_PATH, 'utf8');
  // Strip YAML frontmatter.
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  // The skill's own H1 would duplicate the file H1 required by the spec;
  // everything after it (the ## sections) is the detail content.
  const withoutH1 = body.replace(/^# .*\n/, '').trimStart();

  const header = [
    '# Plannotator',
    '',
    '> Plannotator is a local, browser-based review layer for agent coding workflows: plan review, code review, and document or live-app annotation. A human marks things up in the UI and structured feedback returns to the agent on stdout. This file is the complete CLI reference, generated from the same source agents install as a skill.',
    '',
    '',
  ].join('\n');

  const docsSection = [
    '',
    '## Docs',
    '',
    '- [GitHub repository](https://github.com/backnotprop/plannotator): source, issues, and releases',
    '- [Releases](https://github.com/backnotprop/plannotator/releases): changelogs and binaries',
    '- [Install script](https://plannotator.ai/install.sh): macOS and Linux installer',
    '- [guides.show](https://guides.show): portable Guided Review viewer and share host',
    '',
  ].join('\n');

  return header + withoutH1 + docsSection;
}

export const GET: APIRoute = () => {
  return new Response(buildLlmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
