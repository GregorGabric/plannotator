import type { PRContext, PRMetadata, PRRuntime } from './pr-types';

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTH_CACHE_MS = 5 * 60 * 1000;
const PRIVATE_IPV4_RE = /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IPV6_RE = /^\[(?:::1|::ffff:|fe80:|fc|fd)/i;

interface ProviderAuthCacheEntry {
  readonly expiresAt: number;
  readonly promise: Promise<Record<string, string>>;
}

const providerAuthCache = new Map<string, ProviderAuthCacheEntry>();

export class PRArtifactDocumentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PRArtifactDocumentError';
    this.status = status;
  }
}

export interface PRArtifactDocument {
  readonly content: string;
  readonly contentType: string;
}

function contextMarkdown(context: PRContext): readonly string[] {
  return [
    context.body,
    ...context.comments.map((comment) => comment.body),
    ...context.reviews.map((review) => review.body),
    ...context.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.body)),
  ];
}

function isReferencedByContext(url: URL, metadata: PRMetadata, context: PRContext): boolean {
  const metadataOrigin = new URL(metadata.url).origin.toLowerCase();
  const needles = [url.href];
  if (url.origin.toLowerCase() === metadataOrigin) {
    needles.push(`${url.pathname}${url.search}`);
  }
  return contextMarkdown(context).some((markdown) => {
    const decodedEntities = markdown.replace(/&amp;/gi, '&');
    return needles.some((needle) => decodedEntities.includes(needle));
  });
}

function isGitHubArtifactHost(url: URL, metadata: Extract<PRMetadata, { platform: 'github' }>): boolean {
  const host = url.hostname.toLowerCase();
  const providerHost = metadata.host.toLowerCase();
  if (host === providerHost || (providerHost === 'github.com' && host === 'github.com')) {
    if (/^\/user-attachments\/(?:assets|files)\//.test(url.pathname)) return true;
    const repoPrefix = `/${metadata.owner}/${metadata.repo}/`;
    return url.pathname.startsWith(`${repoPrefix}blob/`)
      || url.pathname.startsWith(`${repoPrefix}raw/`);
  }
  if (providerHost !== 'github.com') return false;
  if (host === 'raw.githubusercontent.com') {
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    return owner?.toLowerCase() === metadata.owner.toLowerCase()
      && repo?.toLowerCase() === metadata.repo.toLowerCase();
  }
  return host === 'user-images.githubusercontent.com'
    || host === 'private-user-images.githubusercontent.com';
}

function isGitLabArtifactHost(url: URL, metadata: Extract<PRMetadata, { platform: 'gitlab' }>): boolean {
  if (url.hostname.toLowerCase() !== metadata.host.toLowerCase()) return false;
  const projectPath = `/${metadata.projectPath.replace(/^\/+|\/+$/g, '')}`;
  return url.pathname.startsWith('/uploads/')
    || url.pathname.startsWith(`${projectPath}/uploads/`)
    || url.pathname.startsWith(`${projectPath}/-/raw/`)
    || url.pathname.startsWith(`${projectPath}/-/blob/`);
}

function providerContentUrl(url: URL, metadata: PRMetadata): URL {
  if (metadata.platform === 'github') {
    const providerHost = metadata.host.toLowerCase();
    const repoPrefix = `/${metadata.owner}/${metadata.repo}/`;
    const blobPrefix = `${repoPrefix}blob/`;
    const rawPrefix = `${repoPrefix}raw/`;
    if (url.hostname.toLowerCase() === providerHost && url.pathname.startsWith(blobPrefix)) {
      const remainder = url.pathname.slice(blobPrefix.length);
      if (providerHost === 'github.com') {
        return new URL(`https://raw.githubusercontent.com${repoPrefix}${remainder}${url.search}`);
      }
      return new URL(`${url.origin}${rawPrefix}${remainder}${url.search}`);
    }
    if (
      providerHost === 'github.com'
      && url.hostname.toLowerCase() === 'github.com'
      && url.pathname.startsWith(rawPrefix)
    ) {
      const remainder = url.pathname.slice(rawPrefix.length);
      return new URL(`https://raw.githubusercontent.com${repoPrefix}${remainder}${url.search}`);
    }
    return url;
  }

  const blobMarker = '/-/blob/';
  if (url.pathname.includes(blobMarker)) {
    const rawUrl = new URL(url);
    rawUrl.pathname = rawUrl.pathname.replace(blobMarker, '/-/raw/');
    return rawUrl;
  }
  return url;
}

/** True only for context-referenced attachment/file URLs on the active provider. */
export function isPRArtifactDocumentUrlAllowed(
  rawUrl: string,
  metadata: PRMetadata,
  context: PRContext,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const providerProtocol = new URL(metadata.url).protocol;
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.protocol !== providerProtocol
  ) return false;
  url.hash = '';
  const allowedHost = metadata.platform === 'github'
    ? isGitHubArtifactHost(url, metadata)
    : isGitLabArtifactHost(url, metadata);
  return allowedHost && isReferencedByContext(url, metadata, context);
}

function isPrivateNetworkUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.local')
    || PRIVATE_IPV4_RE.test(host)
    || PRIVATE_IPV6_RE.test(host);
}

function mayFollowProviderRedirect(currentUrl: URL, nextUrl: URL): boolean {
  if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') return false;
  return (nextUrl.protocol === 'https:' || nextUrl.protocol === 'http:')
    && !isPrivateNetworkUrl(nextUrl);
}

async function providerAuthHeaders(runtime: PRRuntime, metadata: PRMetadata): Promise<Record<string, string>> {
  const cacheKey = `${metadata.platform}:${metadata.host.toLowerCase()}`;
  const cached = providerAuthCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async (): Promise<Record<string, string>> => {
    try {
      const command = metadata.platform === 'github' ? 'gh' : 'glab';
      const args = metadata.platform === 'github'
        ? ['auth', 'token', '--hostname', metadata.host]
        : ['config', 'get', 'token', '--host', metadata.host];
      const result = await runtime.runCommand(command, args);
      const token = result.exitCode === 0 ? result.stdout.trim() : '';
      if (token === '') return {};
      return metadata.platform === 'github'
        ? { Authorization: `Bearer ${token}` }
        : { 'PRIVATE-TOKEN': token };
    } catch {
      return {};
    }
  })();
  providerAuthCache.set(cacheKey, { expiresAt: Date.now() + AUTH_CACHE_MS, promise });
  const headers = await promise;
  if (Object.keys(headers).length === 0) {
    providerAuthCache.delete(cacheKey);
  }
  return headers;
}

function shouldSendProviderAuth(url: URL, metadata: PRMetadata): boolean {
  const host = url.hostname.toLowerCase();
  if (metadata.platform === 'gitlab') return host === metadata.host.toLowerCase();
  return host === metadata.host.toLowerCase()
    || host === 'raw.githubusercontent.com'
    || host === 'private-user-images.githubusercontent.com';
}

async function readTextWithLimit(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    throw new PRArtifactDocumentError('Artifact document is too large to preview', 413);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const content = await response.text();
    if (new TextEncoder().encode(content).byteLength > MAX_DOCUMENT_BYTES) {
      throw new PRArtifactDocumentError('Artifact document is too large to preview', 413);
    }
    return content;
  }

  const decoder = new TextDecoder();
  let content = '';
  let totalBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    totalBytes += chunk.value.byteLength;
    if (totalBytes > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new PRArtifactDocumentError('Artifact document is too large to preview', 413);
    }
    content += decoder.decode(chunk.value, { stream: true });
  }
  return content + decoder.decode();
}

/** Fetch one active PR/MR document without exposing provider credentials to the browser. */
export async function fetchPRArtifactDocument(
  runtime: PRRuntime,
  metadata: PRMetadata,
  context: PRContext,
  rawUrl: string,
): Promise<PRArtifactDocument> {
  if (!isPRArtifactDocumentUrlAllowed(rawUrl, metadata, context)) {
    throw new PRArtifactDocumentError('Artifact URL is not available in this review', 403);
  }

  const providerHeaders = await providerAuthHeaders(runtime, metadata);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let currentUrl = providerContentUrl(new URL(rawUrl), metadata);
  currentUrl.hash = '';
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html, text/markdown, text/plain;q=0.9, */*;q=0.1',
          'User-Agent': 'Plannotator artifact review',
          ...(shouldSendProviderAuth(currentUrl, metadata) ? providerHeaders : {}),
        },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null || redirects === MAX_REDIRECTS) {
          throw new PRArtifactDocumentError('Artifact document redirected too many times', 502);
        }
        const nextUrl = new URL(location, currentUrl);
        if (!mayFollowProviderRedirect(currentUrl, nextUrl)) {
          throw new PRArtifactDocumentError('Artifact document redirected to a blocked address', 403);
        }
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PRArtifactDocumentError(`Artifact host returned HTTP ${response.status}`, 502);
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
        || 'text/plain';
      return { content: await readTextWithLimit(response), contentType };
    }
    throw new PRArtifactDocumentError('Artifact document redirected too many times', 502);
  } catch (error) {
    if (error instanceof PRArtifactDocumentError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PRArtifactDocumentError('Artifact document request timed out', 504);
    }
    throw new PRArtifactDocumentError('Failed to fetch artifact document', 502);
  } finally {
    clearTimeout(timeout);
  }
}
