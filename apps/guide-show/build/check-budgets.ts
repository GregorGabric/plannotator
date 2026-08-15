/**
 * Size budgets for the portable viewer (decision record D1: the exported file
 * is small because the renderer lives on the CDN — so the renderer itself must
 * stay lean). Fails the build when the entry grows past these gzip sizes.
 *   bun build/check-budgets.ts
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { ViewerManifest } from './manifest-plugin';

const BUDGETS = {
  jsGzipBytes: 400 * 1024,
  cssGzipBytes: 64 * 1024,
};

const dir = path.resolve(import.meta.dirname, '../dist/viewer');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as ViewerManifest;
const gz = (file: string) => gzipSync(readFileSync(path.join(dir, file)), { level: 9 }).byteLength;
const js = gz(manifest.js);
const css = gz(manifest.css);
const langCount = Object.keys(manifest.langs).length;
const report = [
  `viewer js  ${manifest.js}  ${(js / 1024).toFixed(1)} KB gz  (budget ${(BUDGETS.jsGzipBytes / 1024).toFixed(0)} KB)`,
  `viewer css ${manifest.css}  ${(css / 1024).toFixed(1)} KB gz  (budget ${(BUDGETS.cssGzipBytes / 1024).toFixed(0)} KB)`,
  `grammar chunks: ${langCount}`,
];
console.log(report.join('\n'));
const failures: string[] = [];
if (js > BUDGETS.jsGzipBytes) failures.push(`viewer js exceeds budget by ${((js - BUDGETS.jsGzipBytes) / 1024).toFixed(1)} KB gz`);
if (css > BUDGETS.cssGzipBytes) failures.push(`viewer css exceeds budget by ${((css - BUDGETS.cssGzipBytes) / 1024).toFixed(1)} KB gz`);
if (langCount < 100) failures.push(`expected per-language grammar chunks, found ${langCount} — did dynamic imports get inlined?`);
if (!manifest.jsIntegrity.startsWith('sha384-') || !manifest.cssIntegrity.startsWith('sha384-')) failures.push('manifest is missing SRI hashes');
if (failures.length) {
  console.error('\nBUDGET FAILURES:\n- ' + failures.join('\n- '));
  process.exit(1);
}
