import { useEffect, useState } from 'react';

/** Loading state for a remote HTML or Markdown artifact. */
export type RemoteArtifactDocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly content: string }
  | { readonly status: 'error' };

/**
 * Fetch a remote document while owning cancellation for the mounted preview.
 * Cross-origin and authentication failures are intentionally reduced to a
 * stable error state so callers can offer the artifact's external URL.
 */
export function useRemoteArtifactDocument(url: string): RemoteArtifactDocumentState {
  const [state, setState] = useState<RemoteArtifactDocumentState>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((content) => {
        if (!controller.signal.aborted) setState({ status: 'ready', content });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [url]);
  return state;
}

/** Inject a safe base element so relative assets resolve against the artifact URL. */
export function injectArtifactBaseUrl(rawHtml: string, artifactUrl: string): string {
  const href = artifactUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const base = `<base href="${href}">`;
  if (/<head\b[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);
  }
  return `${base}${rawHtml}`;
}
