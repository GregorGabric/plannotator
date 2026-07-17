import { describe, expect, it } from 'bun:test';
import {
  artifactContentBaseUrl,
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
