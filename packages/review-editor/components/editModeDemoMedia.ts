/**
 * Demo media for the Edit Mode announcement dialog.
 *
 * The real asset is a short screen recording (webm, kept under ~2.5MB) that
 * lands as `packages/review-editor/assets/edit-mode-demo.webm` in a follow-up
 * commit. The review app builds to a single-file HTML bundle
 * (vite-plugin-singlefile with `assetsInlineLimit` raised far above the asset
 * size in `apps/review/vite.config.ts`), so a plain static import is inlined
 * as a base64 data URI at build time. No runtime fetch, no external host.
 *
 * Swapping the placeholder for the real recording is a one-line change plus
 * the asset file:
 *
 *   import demoVideo from '../assets/edit-mode-demo.webm';
 *   export const EDIT_MODE_DEMO_VIDEO_SRC: string | null = demoVideo;
 *
 * (`declare module '*.webm'` already exists in `packages/ui/globals.d.ts`.)
 * While this is null, the dialog renders its built-in static placeholder.
 */
export const EDIT_MODE_DEMO_VIDEO_SRC: string | null = null;
