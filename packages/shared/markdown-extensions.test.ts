import { describe, expect, test } from "bun:test";
import {
	buildAnnotatableDocRegex,
	buildAnnotatableExtensionsHint,
	buildAnnotatableTextRegex,
	isAnnotatableDocPath,
	isAnnotatableTextPath,
	shouldStripFrontmatter,
} from "./annotatable";
import { normalizeMarkdownExtensions, resolveMarkdownExtensions } from "./markdown-extensions";

describe("normalizeMarkdownExtensions", () => {
	test("keeps well-formed dot-led extensions, lowercased and deduplicated", () => {
		expect(normalizeMarkdownExtensions([".livemd", ".LiveMD", "  .qmd  "])).toEqual([
			".livemd",
			".qmd",
		]);
	});

	test("drops entries that are not usable extensions instead of failing the session", () => {
		expect(
			normalizeMarkdownExtensions([
				"livemd", // dotless
				"", // empty
				".", // dot only
				"*.livemd", // glob
				"docs/*.livemd", // path
				"..\\win.livemd", // separator
				".live md", // whitespace
				42, // not a string
				null,
				{ ext: ".livemd" },
			]),
		).toEqual([]);
	});

	test("rejects non-array values", () => {
		expect(normalizeMarkdownExtensions(".livemd")).toEqual([]);
		expect(normalizeMarkdownExtensions(undefined)).toEqual([]);
		expect(normalizeMarkdownExtensions({ 0: ".livemd" })).toEqual([]);
	});

	// SECURITY: annotate copies file contents into the data dir, so `.env` is a
	// deliberate exclusion from the built-in set. Config must not be a way back
	// in, in any casing or with surrounding whitespace.
	test(".env can never be registered through config", () => {
		expect(normalizeMarkdownExtensions([".env"])).toEqual([]);
		expect(normalizeMarkdownExtensions([" .ENV "])).toEqual([]);
		expect(isAnnotatableTextPath(".env", normalizeMarkdownExtensions([".env"]))).toBe(false);
		expect(isAnnotatableTextPath("app/.env", [".livemd"])).toBe(false);
	});

	test("built-in extensions are dropped rather than duplicated into the regex", () => {
		expect(normalizeMarkdownExtensions([".md", ".html", ".env.example", ".livemd"])).toEqual([
			".livemd",
		]);
	});

	test("resolveMarkdownExtensions reads the config key", () => {
		expect(resolveMarkdownExtensions({})).toEqual([]);
		expect(resolveMarkdownExtensions({ markdownExtensions: [".livemd"] })).toEqual([".livemd"]);
		expect(resolveMarkdownExtensions({ markdownExtensions: ["livemd"] })).toEqual([]);
	});
});

describe("configured extensions in the annotatable predicates", () => {
	const extra = [".livemd"];

	test("a configured extension is annotatable text, a document, and matched by both regexes", () => {
		expect(isAnnotatableTextPath("notes.livemd", extra)).toBe(true);
		expect(isAnnotatableDocPath("notes.livemd", extra)).toBe(true);
		expect(buildAnnotatableTextRegex(extra).test("notes.livemd")).toBe(true);
		expect(buildAnnotatableDocRegex(extra).test("notes.livemd")).toBe(true);
	});

	test("without configuration the same path stays unsupported", () => {
		expect(isAnnotatableTextPath("notes.livemd")).toBe(false);
		expect(isAnnotatableDocPath("notes.livemd")).toBe(false);
		expect(buildAnnotatableTextRegex().test("notes.livemd")).toBe(false);
	});

	test("the extension must terminate the path, and its dot is not a wildcard", () => {
		expect(isAnnotatableTextPath("notes.livemd.bin", extra)).toBe(false);
		expect(isAnnotatableTextPath("noteszlivemd", extra)).toBe(false);
	});

	test("configuring extensions never narrows the built-in set", () => {
		expect(isAnnotatableTextPath("notes.md", extra)).toBe(true);
		expect(isAnnotatableDocPath("page.html", extra)).toBe(true);
		expect(isAnnotatableTextPath("app.ts", extra)).toBe(false);
	});

	// Extras are markdown, so frontmatter is stripped for them — unlike the
	// built-in plain-text formats, where `---` is real content.
	test("configured extensions strip frontmatter like .md does", () => {
		expect(shouldStripFrontmatter("notes.livemd", extra)).toBe(true);
		expect(shouldStripFrontmatter("notes.livemd")).toBe(true);
		expect(shouldStripFrontmatter("deploy.yaml", extra)).toBe(false);
	});

	test("the supported-types hint names the configured extensions", () => {
		expect(buildAnnotatableExtensionsHint(extra)).toContain(".livemd");
		expect(buildAnnotatableExtensionsHint()).not.toContain(".livemd");
	});
});
