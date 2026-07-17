import { describe, expect, test } from 'bun:test';
import type { GithubPRMetadata, GitlabMRMetadata, PRContext, PRRuntime } from './pr-types';
import {
  fetchPRArtifactDocument,
  isPRArtifactDocumentUrlAllowed,
} from './pr-artifact-document';

const context: PRContext = {
  body: [
    '[explainer](https://github.com/user-attachments/files/123/explainer.html)',
    '[source](https://raw.githubusercontent.com/acme/widgets/main/review.md)',
    '[committed](https://github.com/acme/widgets/blob/main/docs/review.html)',
  ].join('\n'),
  state: 'OPEN',
  isDraft: false,
  labels: [],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  comments: [],
  reviews: [],
  reviewThreads: [],
  checks: [],
  linkedIssues: [],
};

const github: GithubPRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'widgets',
  number: 1,
  title: 'Artifacts',
  author: 'reviewer',
  baseBranch: 'main',
  headBranch: 'feature',
  baseSha: 'base',
  headSha: 'head',
  url: 'https://github.com/acme/widgets/pull/1',
};

describe('isPRArtifactDocumentUrlAllowed', () => {
  test('allows referenced GitHub uploads and raw files from the active repository', () => {
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/user-attachments/files/123/explainer.html',
      github,
      context,
    )).toBe(true);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/acme/widgets/blob/main/docs/review.html',
      github,
      context,
    )).toBe(true);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://raw.githubusercontent.com/acme/widgets/main/review.md',
      github,
      context,
    )).toBe(true);
  });

  test('rejects unreferenced URLs and raw files from a different repository', () => {
    expect(isPRArtifactDocumentUrlAllowed(
      'https://github.com/user-attachments/files/999/private.html',
      github,
      context,
    )).toBe(false);
    expect(isPRArtifactDocumentUrlAllowed(
      'https://raw.githubusercontent.com/other/widgets/main/review.md',
      github,
      {
        ...context,
        body: '[source](https://raw.githubusercontent.com/other/widgets/main/review.md)',
      },
    )).toBe(false);
    expect(isPRArtifactDocumentUrlAllowed(
      'http://github.com/user-attachments/files/123/explainer.html',
      github,
      {
        ...context,
        body: '[explainer](http://github.com/user-attachments/files/123/explainer.html)',
      },
    )).toBe(false);
  });

  test('allows a relative GitLab upload only when the active MR references it', () => {
    const gitlab: GitlabMRMetadata = {
      platform: 'gitlab',
      host: 'gitlab.example.com',
      projectPath: 'acme/widgets',
      iid: 7,
      title: 'Artifacts',
      author: 'reviewer',
      baseBranch: 'main',
      headBranch: 'feature',
      baseSha: 'base',
      headSha: 'head',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
    };
    expect(isPRArtifactDocumentUrlAllowed(
      'https://gitlab.example.com/uploads/hash/explainer.html',
      gitlab,
      { ...context, body: '[explainer](/uploads/hash/explainer.html)' },
    )).toBe(true);
  });
});

describe('fetchPRArtifactDocument', () => {
  test('fetches a GitHub blob link from its raw-content URL', async () => {
    const runtime: PRRuntime = {
      async runCommand() {
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let requestedUrl = '';
    globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return new Response('<main>Review</main>', { headers: { 'content-type': 'text/html' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        github,
        context,
        'https://github.com/acme/widgets/blob/main/docs/review.html',
      );
      expect(result.content).toBe('<main>Review</main>');
      expect(requestedUrl).toBe('https://raw.githubusercontent.com/acme/widgets/main/docs/review.html');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reads GitLab credentials with the supported per-host config command', async () => {
    const gitlab: GitlabMRMetadata = {
      platform: 'gitlab',
      host: 'gitlab.example.com',
      projectPath: 'acme/widgets',
      iid: 7,
      title: 'Artifacts',
      author: 'reviewer',
      baseBranch: 'main',
      headBranch: 'feature',
      baseSha: 'base',
      headSha: 'head',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7',
    };
    const commands: string[] = [];
    const runtime: PRRuntime = {
      async runCommand(command, args) {
        commands.push([command, ...args].join(' '));
        return { stdout: 'test-token\n', stderr: '', exitCode: 0 };
      },
    };
    const originalFetch = globalThis.fetch;
    let receivedToken = '';
    globalThis.fetch = async (_input, init) => {
      receivedToken = new Headers(init?.headers).get('PRIVATE-TOKEN') ?? '';
      return new Response('# Review', { headers: { 'content-type': 'text/markdown' } });
    };
    try {
      const result = await fetchPRArtifactDocument(
        runtime,
        gitlab,
        { ...context, body: '[review](/uploads/hash/review.md)' },
        'https://gitlab.example.com/uploads/hash/review.md',
      );
      expect(result.content).toBe('# Review');
      expect(receivedToken).toBe('test-token');
      expect(commands).toEqual(['glab config get token --host gitlab.example.com']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
