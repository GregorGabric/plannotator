import { describe, expect, it } from 'bun:test';
import {
  artifactContentBaseUrl,
  artifactContentProxyUrl,
  injectArtifactBaseUrl,
  resolveArtifactReferenceUrl,
} from './artifactDocument';

const github = { platform: 'github', host: 'github.com' } as const;
const gitlab = { platform: 'gitlab', host: 'gitlab.com' } as const;

describe('injectArtifactBaseUrl', () => {
  it('places the base inside an existing head and escapes the URL', () => {
    expect(
      injectArtifactBaseUrl(
        '<html><head><title>Review</title></head><body></body></html>',
        'https://example.com/path/review.html?left=1&right="two"',
        github,
      ),
    ).toContain(
      '<head><base href="https://example.com/path/review.html?left=1&amp;right=&quot;two&quot;">',
    );
  });

  it('prepends the base when the document has no head', () => {
    expect(injectArtifactBaseUrl('<main>Review</main>', 'https://example.com/review.html', github))
      .toBe('<base href="https://example.com/review.html"><main>Review</main>');
  });

  it('routes private HTML resources through the authenticated content endpoint', () => {
    const artifactUrl = 'https://github.com/acme/widgets/blob/main/docs/review.html';
    const html = injectArtifactBaseUrl(
      '<head><link rel="stylesheet" href="./review.css"></head><body><img src="../images/diff.png"><style>.hero{background:url(../images/hero.png)}</style></body>',
      artifactUrl,
      github,
    );
    expect(html).toContain('/api/pr-artifact-content?');
    expect(html).toContain('review.css');
    expect(html).toContain('diff.png');
    expect(html).toContain('hero.png');
    expect(html).toContain('source=');
    expect(html).not.toContain('<img src="../images/diff.png">');
  });
});

describe('artifactContentProxyUrl', () => {
  it('keeps the target and provenance source in a same-origin URL', () => {
    const proxy = artifactContentProxyUrl(
      'https://raw.githubusercontent.com/acme/widgets/main/image.png',
      'https://github.com/acme/widgets/blob/main/review.html',
    );
    expect(proxy.startsWith('/api/pr-artifact-content?')).toBe(true);
    const params = new URL(proxy, 'http://localhost').searchParams;
    expect(params.get('url')).toBe('https://raw.githubusercontent.com/acme/widgets/main/image.png');
    expect(params.get('source')).toBe('https://github.com/acme/widgets/blob/main/review.html');
  });
});

describe('resolveArtifactReferenceUrl', () => {
  const artifactUrl = 'https://github.com/user-attachments/files/123/explainer.md';

  it('resolves Markdown links and local image-proxy paths against the artifact', () => {
    expect(resolveArtifactReferenceUrl('../images/diff.png', artifactUrl, github)).toBe(
      'https://github.com/user-attachments/files/images/diff.png',
    );
    expect(
      resolveArtifactReferenceUrl('/api/image?path=diagram.png', artifactUrl, github),
    ).toBe('https://github.com/user-attachments/files/123/diagram.png');
  });

  it('leaves document anchors and unsafe protocols alone', () => {
    expect(resolveArtifactReferenceUrl('#quality-diff', artifactUrl, github)).toBeNull();
    expect(resolveArtifactReferenceUrl('javascript:alert(1)', artifactUrl, github)).toBeNull();
    expect(resolveArtifactReferenceUrl('data:image/png;base64,AAAA', artifactUrl, github)).toBeNull();
  });
});

describe('artifactContentBaseUrl', () => {
  it('maps GitHub and GitLab file viewers to their raw-content equivalents', () => {
    expect(artifactContentBaseUrl(
      'https://github.com/acme/widgets/blob/feature/docs/explainer.html',
      github,
    )).toBe('https://raw.githubusercontent.com/acme/widgets/feature/docs/explainer.html');
    expect(artifactContentBaseUrl(
      'https://gitlab.com/acme/widgets/-/blob/feature/docs/explainer.html',
      gitlab,
    )).toBe('https://gitlab.com/acme/widgets/-/raw/feature/docs/explainer.html');
  });

  it('uses the raw base when resolving assets in a repository-backed explainer', () => {
    expect(resolveArtifactReferenceUrl(
      './diagram.png',
      'https://github.com/acme/widgets/blob/feature/docs/explainer.md',
      github,
    )).toBe('https://raw.githubusercontent.com/acme/widgets/feature/docs/diagram.png');
  });

  it('does not reinterpret GitHub-shaped paths on an external host', () => {
    const artifactUrl = 'https://example.com/acme/widgets/blob/main/explainer.html';
    expect(artifactContentBaseUrl(artifactUrl, github)).toBe(artifactUrl);
  });
});
