/**
 * Keep the checked-in viewer manifest (what Plannotator's export embeds) equal
 * to what the viewer build actually produces.
 *   bun build/sync-manifest.ts          # write viewer-manifest.json from dist/viewer
 *   bun build/sync-manifest.ts --check  # exit 1 if they differ (CI / release gate)
 * The build is deterministic (content hashes, no timestamps), so a mismatch
 * means the viewer changed without the manifest being refreshed — refresh it,
 * commit it, and the same release both publishes the viewer and ships a
 * binary that pins it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const built = path.resolve(import.meta.dirname, '../dist/viewer/manifest.json');
const checkedIn = path.resolve(import.meta.dirname, '../viewer-manifest.json');
const fresh = readFileSync(built, 'utf8');
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(checkedIn, 'utf8'); } catch {}
  if (current !== fresh) {
    console.error('apps/guide-show/viewer-manifest.json is out of date. Run: bun run --cwd apps/guide-show build:viewer && bun run --cwd apps/guide-show sync:manifest');
    process.exit(1);
  }
  console.log('viewer-manifest.json is in sync');
} else {
  writeFileSync(checkedIn, fresh);
  console.log(`wrote ${checkedIn}`);
}
