import { describe, expect, it } from 'bun:test';
import { injectArtifactBaseUrl } from './artifactDocument';

describe('injectArtifactBaseUrl', () => {
  it('places the base inside an existing head and escapes the URL', () => {
    expect(
      injectArtifactBaseUrl(
        '<html><head><title>Review</title></head><body></body></html>',
        'https://example.com/path/review.html?left=1&right="two"',
      ),
    ).toContain(
      '<head><base href="https://example.com/path/review.html?left=1&amp;right=&quot;two&quot;">',
    );
  });

  it('prepends the base when the document has no head', () => {
    expect(injectArtifactBaseUrl('<main>Review</main>', 'https://example.com/review.html'))
      .toBe('<base href="https://example.com/review.html"><main>Review</main>');
  });
});
