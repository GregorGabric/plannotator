import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('review entry assets', () => {
  test.each(['apps/portal/index.html', 'apps/hook/index.html', 'apps/review/index.html'])(
    '%s has no externally hosted startup scripts or styles',
    (path) => {
      expect(read(path)).not.toMatch(
        /<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i,
      );
    },
  );

  // The portal mounts the same @plannotator/editor App as the hook, so it needs
  // the identical shell: without it the mobile layout's safe-area tokens are
  // inert and the document scrolls behind the app's own scroll ownership.
  test.each(['apps/hook/index.html', 'apps/review/index.html', 'apps/portal/index.html'])(
    '%s leaves scrolling to the visible-viewport application shell',
    (path) => {
      const html = read(path);
      expect(html).toContain('viewport-fit=cover');
      expect(html).toContain('<body class="overflow-hidden overscroll-none antialiased">');
      expect(html).toContain('<div id="root" class="h-full overflow-hidden"></div>');
      expect(html).not.toContain('min-h-screen');
    },
  );

  test('the plan surface extends its active canvas behind mobile browser controls', () => {
    const editor = read('packages/editor/App.tsx');
    const theme = read('packages/ui/theme.css');

    expect(editor).toContain("const browserCanvas = isHtmlSurface || gridEnabled ? 'background' : 'card';");
    expect(editor).toContain('data-pn-browser-canvas={browserCanvas}');
    expect(editor).toContain("data-pn-document-scroll={usesDocumentScroll ? 'true' : undefined}");
    expect(editor).toContain('sticky={!usesDocumentScroll}');
    expect(editor).toContain('stickyActions={uiPrefs.stickyActionsEnabled && !usesDocumentScroll}');
    expect(editor).toContain("overflowY={usesDocumentScroll ? 'visible' : 'auto'}");
    expect(theme).toContain('html:has([data-pn-browser-canvas="card"])');
    expect(theme).toContain('html:has([data-pn-document-scroll="true"])');
    expect(theme).toContain('background-color: var(--card);');
  });

  test('the app bundles its default fonts and syntax highlighting', () => {
    const editorCss = read('packages/editor/index.css');
    expect(editorCss).toContain('@import "@fontsource-variable/inter";');
    expect(editorCss).toContain('@import "@fontsource-variable/geist-mono";');

    const theme = read('packages/ui/themes/plannotator.css');
    expect(theme).toContain("--font-sans: 'Inter Variable'");
    expect(theme).toContain("--font-mono: 'Geist Mono Variable'");

    // Syntax highlighting is the bundled Shiki instance @pierre/diffs already
    // runs (JavaScript regex engine, no WASM, no network). A CDN-loaded
    // highlighter or a runtime wasm fetch would break the single-file builds.
    const codeBlock = read('packages/ui/components/blocks/CodeBlock.tsx');
    expect(codeBlock).toContain("from '../../utils/codeHighlight'");

    const highlighter = read('packages/ui/utils/codeHighlight.ts');
    expect(highlighter).toContain("import('@pierre/diffs')");
    expect(highlighter).toContain("preferredHighlighter: 'shiki-js'");
    expect(highlighter).not.toMatch(/https?:\/\//);
  });

  // @plannotator/ui loads KaTeX and the username dictionary through slots
  // (utils/math.ts, utils/generateIdentity.ts) so hosts that bundle by route
  // can leave them out of a document read. Plannotator's parity rests on two
  // side-effect imports per app entry: without them, plans with math would
  // paint TeX for a frame in every runtime and identities would come from the
  // 16-word fallback pool, with no error anywhere. Both apps must carry both.
  test.each(['packages/editor/App.tsx', 'packages/review-editor/App.tsx'])(
    '%s registers the eager math renderer and identity dictionary',
    (path) => {
      const source = read(path);
      expect(source).toContain("import '@plannotator/ui/utils/math-eager';");
      expect(source).toContain("import '@plannotator/ui/utils/identity-tater';");
    },
  );

  test('the eager entries register synchronously at module evaluation', () => {
    const math = read('packages/ui/utils/math-eager.ts');
    expect(math).toContain("import katex from 'katex';");
    expect(math).toContain('setMathRenderer(katex);');
    const identity = read('packages/ui/utils/identity-tater.ts');
    expect(identity).toContain("from 'unique-username-generator';");
    expect(identity).toContain('setIdentityGenerator(generateTaterIdentity);');
  });

  // The other half of the optimization: the renderers must stay OFF the
  // static import graph of the components, otherwise a host's bundler puts
  // them back into every document read and the slots become decoration.
  test('renderer runtimes are not statically imported by the components', () => {
    const staticImport = (spec: string) => new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+['"]${spec}['"]`, 'm');
    expect(read('packages/ui/components/blocks/MathBlock.tsx')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/components/InlineMarkdown.tsx')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/utils/math.ts')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/utils/math.ts')).toContain("import('katex')");
    expect(read('packages/ui/components/MermaidBlock.tsx')).not.toMatch(staticImport('mermaid'));
    expect(read('packages/ui/components/MermaidBlock.tsx')).toContain("import('mermaid')");
    expect(read('packages/ui/components/GraphvizBlock.tsx')).not.toMatch(staticImport('@viz-js/viz'));
    expect(read('packages/ui/components/GraphvizBlock.tsx')).toContain("import('@viz-js/viz')");
    expect(read('packages/ui/utils/generateIdentity.ts')).not.toMatch(staticImport('unique-username-generator'));
  });

  // Built-artifact check for the same guarantee: a lost eager import would
  // still type-check and pass every unit test, but the single-file bundles
  // would no longer inline the renderer. These markers are string literals
  // inside the libraries (a KaTeX class name, a Mermaid diagram id, an
  // Emscripten symbol from Graphviz, the dictionary's exported function) and
  // survive minification. dist/ is gitignored, so this skips on an unbuilt
  // checkout; the CI job that builds the bundles runs it right after.
  const markerExpectations: Array<[bundle: string, markers: string[]]> = [
    ['apps/hook/dist/index.html', ['katex-display', 'flowchart-v2', 'viz_set_y_invert', 'uniqueUsernameGenerator', '__plannotatorLiveConfig']],
    ['apps/review/dist/index.html', ['katex-display', 'uniqueUsernameGenerator', '__plannotatorLiveConfig']],
  ];
  test.each(markerExpectations)('%s still inlines the eagerly registered renderers (skipped if unbuilt)', (path, markers) => {
    const full = resolve(root, path);
    if (!existsSync(full)) return;
    const html = readFileSync(full, 'utf8');
    // Asserted per marker on a boolean so a failure never prints the 20MB bundle.
    const missing = markers.filter((marker) => !html.includes(marker));
    expect({ path, missing }).toEqual({ path, missing: [] });
  });

  test('nothing depends on highlight.js any more', () => {
    for (const manifest of ['packages/ui/package.json', 'packages/review-editor/package.json']) {
      expect(read(manifest)).not.toContain('highlight.js');
    }
  });

  test('the dead Oniguruma WASM is aliased out of every bundled app', () => {
    for (const config of [
      'apps/review/vite.config.ts',
      'apps/hook/vite.config.ts',
      'apps/portal/vite.config.ts',
    ]) {
      expect(read(config)).toContain("'shiki/wasm': path.resolve(");
    }
  });

  // The alias assertions above only read SOURCE. A future @pierre/diffs bump
  // could reach the same inlined blob through a different import specifier and
  // every source check would still pass, so this reads the ARTIFACT: a base64
  // WASM module always starts `\0asm\x01\0\0\0`, which encodes with the
  // `AGFzbQ` prefix regardless of how it got inlined.
  //
  // dist/ is gitignored, so this skips cleanly on an unbuilt checkout. The CI
  // job that builds the bundles runs this file right after the build so the
  // assertion is not silently optional there.
  const bundles = ['apps/review/dist/index.html', 'apps/hook/dist/index.html'];
  test.each(bundles)('%s ships no inlined WebAssembly (skipped if unbuilt)', (path) => {
    const full = resolve(root, path);
    if (!existsSync(full)) return;
    // Asserted on a boolean, not the string: these bundles are ~20MB and a
    // `toContain` failure would print all of it.
    const inlinedWasm = readFileSync(full, 'utf8').includes('AGFzbQ');
    expect({ path, inlinedWasm }).toEqual({ path, inlinedWasm: false });
  });
});

describe('marketing embeds', () => {
  const youtubePosts = [
    'apps/marketing/src/content/blog/local-diff-review-for-coding-agents.md',
    'apps/marketing/src/content/blog/plan-diff-see-what-changed.md',
    'apps/marketing/src/content/blog/plannotator-meets-pi.md',
    'apps/marketing/src/content/blog/sharing-plans-with-your-team.md',
    'apps/marketing/src/content/blog/welcome.md',
  ];

  test.each(youtubePosts)('%s uses YouTube privacy-enhanced embeds', (path) => {
    const content = read(path);
    expect(content).not.toContain('www.youtube.com/embed/');
    expect(content).toContain('www.youtube-nocookie.com/embed/');
  });

  test('the in-app help dialog uses YouTube privacy-enhanced embeds', () => {
    const toolstrip = read('packages/ui/components/AnnotationToolstrip.tsx');
    expect(toolstrip).not.toContain('www.youtube.com/embed/');
    expect(toolstrip).toContain('www.youtube-nocookie.com/embed/');
  });
});
