import { useEffect, useState } from 'react';

/** Loading state for a remote HTML or Markdown artifact. */
export type RemoteArtifactDocumentState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly content: string }
  | { readonly status: 'error' };

type ArtifactDocumentCacheEntry =
  | { readonly status: 'loading'; readonly promise: Promise<string> }
  | { readonly status: 'ready'; readonly content: string; readonly expiresAt: number };

export interface ArtifactProviderLocation {
  readonly platform: 'github' | 'gitlab';
  readonly host: string;
}

const artifactDocumentCache = new Map<string, ArtifactDocumentCacheEntry>();
const MAX_CACHED_DOCUMENTS = 128;
const DOCUMENT_CACHE_TTL_MS = 5 * 60 * 1000;

function readCachedDocument(url: string): ArtifactDocumentCacheEntry | undefined {
  const entry = artifactDocumentCache.get(url);
  if (entry?.status === 'ready' && entry.expiresAt <= Date.now()) {
    artifactDocumentCache.delete(url);
    return undefined;
  }
  return entry;
}

function cacheDocument(url: string, entry: ArtifactDocumentCacheEntry): void {
  artifactDocumentCache.delete(url);
  artifactDocumentCache.set(url, entry);
  if (artifactDocumentCache.size <= MAX_CACHED_DOCUMENTS) return;
  for (const [cachedUrl, cachedEntry] of artifactDocumentCache) {
    if (cachedUrl !== url && cachedEntry.status === 'ready') {
      artifactDocumentCache.delete(cachedUrl);
      return;
    }
  }
}

function loadRemoteArtifactDocument(url: string): Promise<string> {
  const cached = readCachedDocument(url);
  if (cached?.status === 'ready') return Promise.resolve(cached.content);
  if (cached?.status === 'loading') return cached.promise;

  const endpoint = `/api/pr-artifact-document?${new URLSearchParams({ url })}`;
  const promise = fetch(endpoint)
    .then(async (response) => {
      if (response.ok) return response.text();
      // Non-provider documents are intentionally outside the server proxy's
      // allowlist. Preserve the prior browser-fetch behavior for public hosts
      // that opt into CORS while keeping provider credentials server-side.
      if (response.status === 403) {
        const directResponse = await fetch(url);
        if (directResponse.ok) return directResponse.text();
      }
      throw new Error(`HTTP ${response.status}`);
    })
    .then((content) => {
      cacheDocument(url, {
        status: 'ready',
        content,
        expiresAt: Date.now() + DOCUMENT_CACHE_TTL_MS,
      });
      return content;
    })
    .catch((error: unknown) => {
      artifactDocumentCache.delete(url);
      throw error;
    });
  cacheDocument(url, { status: 'loading', promise });
  return promise;
}

/**
 * Fetch a hosted document through the authenticated review server. Requests
 * are shared across gallery and focused views; callers can defer the first
 * request until a preview is near the viewport.
 */
export function useRemoteArtifactDocument(
  url: string,
  enabled = true,
): RemoteArtifactDocumentState {
  const cached = readCachedDocument(url);
  const [state, setState] = useState<RemoteArtifactDocumentState>(
    cached?.status === 'ready' ? cached : { status: 'loading' },
  );
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ status: 'loading' });
      return () => {
        cancelled = true;
      };
    }
    const current = readCachedDocument(url);
    if (current?.status === 'ready') {
      setState(current);
      return () => {
        cancelled = true;
      };
    }
    setState({ status: 'loading' });
    void loadRemoteArtifactDocument(url)
      .then((content) => {
        if (!cancelled) setState({ status: 'ready', content });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);
  return state;
}

/** Resolve a rendered Markdown reference against its remote artifact URL. */
export function resolveArtifactReferenceUrl(
  rawUrl: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  let candidate = trimmed;
  if (trimmed.startsWith('/api/image?')) {
    const localImageUrl = new URL(trimmed, 'http://plannotator.invalid');
    const originalPath = localImageUrl.searchParams.get('path');
    if (originalPath === null || originalPath === '') return null;
    candidate = originalPath;
  }

  try {
    const resolved = new URL(candidate, artifactContentBaseUrl(artifactUrl, provider));
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/** Turn provider file-viewer URLs into raw-content bases for relative assets. */
export function artifactContentBaseUrl(
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string {
  const url = new URL(artifactUrl);
  if (url.hostname.toLowerCase() !== provider.host.toLowerCase()) return artifactUrl;

  const gitlabBlobMarker = '/-/blob/';
  if (provider.platform === 'gitlab' && url.pathname.includes(gitlabBlobMarker)) {
    url.pathname = url.pathname.replace(gitlabBlobMarker, '/-/raw/');
    return url.href;
  }

  if (provider.platform !== 'github') return artifactUrl;
  const githubMatch = /^(\/[^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname);
  if (githubMatch) {
    const repoPrefix = githubMatch[1];
    const remainder = githubMatch[2];
    if (url.hostname.toLowerCase() === 'github.com') {
      return `https://raw.githubusercontent.com${repoPrefix}/${remainder}${url.search}`;
    }
    url.pathname = `${repoPrefix}/raw/${remainder}`;
    return url.href;
  }
  return artifactUrl;
}

/**
 * Repair relative references after RenderedMarkdown has produced DOM. Its
 * normal image resolver targets local files through /api/image; remote
 * artifact documents instead need their own URL as the base.
 */
export function rewriteArtifactMarkdownReferences(
  root: HTMLElement,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): void {
  for (const element of root.querySelectorAll<HTMLElement>('img[src], source[src], video[src]')) {
    const rawSrc = element.getAttribute('src');
    if (rawSrc === null) continue;
    const resolved = resolveArtifactReferenceUrl(rawSrc, artifactUrl, provider);
    if (resolved !== null) element.setAttribute('src', resolved);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[poster]')) {
    const rawPoster = element.getAttribute('poster');
    if (rawPoster === null) continue;
    const resolved = resolveArtifactReferenceUrl(rawPoster, artifactUrl, provider);
    if (resolved !== null) element.setAttribute('poster', resolved);
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const rawHref = link.getAttribute('href');
    if (rawHref === null) continue;
    const resolved = resolveArtifactReferenceUrl(rawHref, artifactUrl, provider);
    if (resolved === null) continue;
    link.href = resolved;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

/** Inject a safe base element so relative assets resolve against the artifact URL. */
export function injectArtifactBaseUrl(
  rawHtml: string,
  artifactUrl: string,
  provider: ArtifactProviderLocation,
): string {
  const href = artifactContentBaseUrl(artifactUrl, provider)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  const base = `<base href="${href}">`;
  if (/<head\b[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);
  }
  return `${base}${rawHtml}`;
}
