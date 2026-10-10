// Builds the GitHub Pages docs site into dist-site/.
//
// docs/*.md is the only content source (docs/history and docs/superpowers
// are internal and never published). Each page is rendered with marked into
// the site/_template.html shell and written to dist-site/<name>.html, so the
// published URLs (./architecture.html, ./api.html, ...) stay stable.
// site/index.html, favicon.svg and .nojekyll are copied alongside, with the
// package.json version injected into the landing page's version chip.
//
// Run with `pnpm build:site` (Node runs this erasable TypeScript natively).

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { Marked, type Token, type Tokens } from "marked";

const root = join(import.meta.dirname, "..");
const docsDir = join(root, "docs");
const siteDir = join(root, "site");
const outDir = join(root, "dist-site");
const BLOB = "https://github.com/ABCrimson/Swarm/blob/main/";

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

// Every placeholder must be present exactly once, or the build fails.
const TITLE = "PAGE_TITLE";
const CONTENT = "<!-- CONTENT -->";
const VERSION = "APP_VERSION";

const read = (path: string): string => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** GitHub's heading-anchor algorithm, so `file.md#anchor` links keep working. */
function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replaceAll(" ", "-");
    let slug = base;
    while (seen.has(slug)) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/**
 * The id the hand-maintained site assigned to h2/h3 in the browser. Kept as a
 * hidden alias wherever it differs from the GitHub slug, so old deep links
 * (`architecture.html#react-19-compiler`) still land on their heading.
 */
const legacySlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Fails if `*` / `**` emphasis markers survive as literal text outside code,
 * so any parse slip that leaves emphasis unrendered is a build error.
 * Intentionally literal asterisks belong in a code span.
 */
function checkEmphasis(html: string, file: string): void {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(pre|code)\b[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]*>/g, "");
  const leftover =
    /\*\*(?=\S)[^*]{0,200}?\S\*\*|(?<![\w*\\])\*(?=[^\s*])[^*]{0,200}?[^\s*\\]\*(?![\w*])/.exec(
      text,
    );
  if (leftover) {
    throw new Error(`${file}: unrendered emphasis in output: ${JSON.stringify(leftover[0])}`);
  }
}

function fillOnce(html: string, placeholder: string, value: string, file: string): string {
  const parts = html.split(placeholder);
  if (parts.length !== 2) {
    throw new Error(`${file}: expected exactly one ${placeholder}, found ${parts.length - 1}`);
  }
  return parts.join(value);
}

/** Fails unless the page's `<nav>` links every docs page, and nothing else local. */
function checkNav(html: string, pages: readonly string[], file: string): void {
  const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  const linked = new Set([...nav.matchAll(/href="\.\/([\w-]+)\.html"/g)].map((m) => m[1]));
  const missing = pages.filter((page) => !linked.has(page));
  const stale = [...linked].filter((page) => page !== "index" && !pages.includes(page));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `${file}: nav is out of sync with docs/*.md (missing: ${missing.join(", ") || "none"}; ` +
        `no such page: ${stale.join(", ") || "none"})`,
    );
  }
}

interface RenderedPage {
  html: string;
  ids: Set<string>;
  /** Links to headings: [target page, anchor] pairs to validate once every page is rendered. */
  anchors: Array<[string, string]>;
}

function renderPage(name: string, pages: readonly string[], template: string): RenderedPage {
  const file = `docs/${name}.md`;
  // GitHub alert markers (`> [!NOTE]`) — the blockquote itself becomes the callout.
  const source = read(join(docsDir, `${name}.md`)).replace(
    /^>\s*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n/gm,
    "",
  );

  const slug = createSlugger();
  const ids = new Set<string>();
  /** GitHub slug -> legacy browser-generated id, for h2/h3 where they differ. */
  const legacyIds = new Map<string, string>();
  const anchors: Array<[string, string]> = [];

  const rewriteHref = (href: string): string => {
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) return href;
    const hash = href.indexOf("#");
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? "" : href.slice(hash);
    if (path === "") {
      anchors.push([name, fragment.slice(1)]);
      return href;
    }
    const target = posix.normalize(posix.join("docs", path));
    const page = target.match(/^docs\/([\w-]+)\.md$/)?.[1];
    if (page !== undefined && pages.includes(page)) {
      if (fragment) anchors.push([page, fragment.slice(1)]);
      return `./${page}.html${fragment}`;
    }
    return `${BLOB}${target}${fragment}`;
  };

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens, this.parser.textRenderer);
        const id = slug(text);
        ids.add(id);
        const legacy = legacySlug(text);
        if ((depth === 2 || depth === 3) && legacy !== "" && legacy !== id) {
          legacyIds.set(id, legacy);
        }
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      // GFM task items render as the static glyph the site has always shown,
      // not as a disabled native checkbox.
      checkbox({ checked }) {
        return checked ? "☑ " : "☐ ";
      },
      blockquote({ tokens }) {
        const [first] = tokens;
        const inner =
          tokens.length === 1 && first?.type === "paragraph"
            ? this.parser.parseInline((first as Tokens.Paragraph).tokens)
            : this.parser.parse(tokens);
        return `<div class="note">${inner}</div>\n`;
      },
      link(token) {
        // Rewrite in place, then fall through to marked's own link renderer.
        token.href = rewriteHref(token.href);
        return false;
      },
    },
  });

  const tokens = marked.lexer(source);
  const next = (from: number): number => {
    let i = from;
    while (tokens[i]?.type === "space") i++;
    return i;
  };

  // H1 + lead blockquote -> hero title and dek.
  const h1At = next(0);
  const h1 = tokens[h1At] as Tokens.Heading | undefined;
  if (h1?.type !== "heading" || h1.depth !== 1) throw new Error(`${file}: must open with an H1`);
  const parser = new marked.Parser(marked.defaults);
  const title = parser.parseInline(h1.tokens, parser.textRenderer);
  let dek = "";
  let bodyAt = next(h1At + 1);
  const lead = tokens[bodyAt] as Tokens.Blockquote | undefined;
  if (lead?.type === "blockquote") {
    const [para] = lead.tokens;
    if (para?.type === "paragraph") dek = parser.parseInline((para as Tokens.Paragraph).tokens);
    bodyAt = next(bodyAt + 1);
  }
  tokens.splice(0, bodyAt);

  // The in-page table of contents is dropped; the template builds a scroll-spy TOC.
  const isToc = (t: Token): boolean =>
    t.type === "heading" &&
    (t as Tokens.Heading).depth === 2 &&
    /^table of contents$/i.test(t.text);
  const tocAt = tokens.findIndex(isToc);
  if (tocAt !== -1) {
    let end = tocAt + 1;
    while (end < tokens.length) {
      const t = tokens[end] as Token;
      if (t.type === "hr") {
        end++;
        break;
      }
      if (t.type === "heading" && (t as Tokens.Heading).depth <= 2) break;
      end++;
    }
    tokens.splice(tocAt, end - tocAt);
  }

  // Legacy aliases go in only once every real id is known, so an alias can
  // never shadow a heading that appears later on the page.
  const aliased = new Set<string>();
  const body = marked
    .parser(tokens)
    .replaceAll("<table>", '<div class="tablewrap"><table>')
    .replaceAll("</table>", "</table></div>")
    .replace(/<h[23] id="([^"]+)">/g, (open, id: string) => {
      const legacy = legacyIds.get(id);
      if (legacy === undefined || ids.has(legacy) || aliased.has(legacy)) return open;
      aliased.add(legacy);
      return `${open}<span id="${legacy}" class="legacy-anchor"></span>`;
    });
  const hero =
    `<div class="hero">\n  <p class="eyebrow">Documentation</p>\n  <h1>${escapeHtml(title)}</h1>\n` +
    (dek ? `  <p class="dek">${dek}</p>\n` : "") +
    "</div>\n";
  checkEmphasis(hero + body, file);

  let html = fillOnce(template, TITLE, escapeHtml(title), "site/_template.html");
  html = fillOnce(html, CONTENT, hero + body, "site/_template.html");
  html = html.replace(`<a href="./${name}.html">`, `<a href="./${name}.html" aria-current="page">`);
  return { html, ids, anchors };
}

const pages = readdirSync(docsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => basename(entry.name, ".md"))
  .sort();
if (pages.length === 0) throw new Error("docs/: no pages found");

const template = read(join(siteDir, "_template.html"));
const index = read(join(siteDir, "index.html"));
checkNav(template, pages, "site/_template.html");
checkNav(index, pages, "site/index.html");
const indexHtml = fillOnce(index, VERSION, `v${escapeHtml(pkg.version)}`, "site/index.html");

const rendered = new Map(pages.map((page) => [page, renderPage(page, pages, template)]));

// Every heading anchor a page links to must exist on the target page.
const broken = [...rendered].flatMap(([page, { anchors }]) =>
  anchors
    .filter(([target, id]) => !rendered.get(target)?.ids.has(id))
    .map(([target, id]) => `  docs/${page}.md -> ${target}.md#${id}`),
);
if (broken.length > 0) {
  throw new Error(`Broken heading anchors:\n${broken.join("\n")}`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [page, { html }] of rendered) writeFileSync(join(outDir, `${page}.html`), html);
writeFileSync(join(outDir, "index.html"), indexHtml);
for (const asset of ["favicon.svg", ".nojekyll"]) {
  copyFileSync(join(siteDir, asset), join(outDir, asset));
}

console.log(
  `dist-site/: index.html + ${pages.length} pages (${pages.join(", ")}) at v${pkg.version}`,
);
