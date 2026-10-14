// Builds the GitHub Pages docs site into dist-site/.
//
// docs/*.md is the only content source (docs/history and docs/superpowers
// are internal and never published). Each page is rendered with marked into
// the site/_template.html shell and written to dist-site/<name>.html, so the
// published URLs (./architecture.html, ./api.html, ...) stay stable. Each page
// gets a contents list built from its h2/h3 headings, a permalink per h2/h3,
// previous/next links in the nav's order and an edit link.
// site/index.html is copied with the latest release filled in (package.json's
// version, dated from its CHANGELOG.md heading), alongside the shared assets.
//
// The build fails rather than publish a page that drifted: a placeholder that
// is missing or repeated, a nav that does not list every page, a heading link
// to an anchor that does not exist, unrendered emphasis, a landing-page doc
// card whose title is not its page's H1, a "proposed next version" that is
// already released, a missing asset, or any resource loaded from another
// origin.
//
// Run with `pnpm build:site` (Node runs this erasable TypeScript natively).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, posix } from "node:path";
import { Marked, type Token, type Tokens } from "marked";

const root = join(import.meta.dirname, "..");
const docsDir = join(root, "docs");
const siteDir = join(root, "site");
const outDir = join(root, "dist-site");
const REPO = "https://github.com/ABCrimson/Swarm";
const BLOB = `${REPO}/blob/main/`;
const EDIT = `${REPO}/edit/main/`;

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

// Every placeholder must be present exactly once, or the build fails.
const TITLE = "PAGE_TITLE";
const DESCRIPTION = "PAGE_DESCRIPTION";
const EDIT_URL = "EDIT_URL";
const CONTENT = "<!-- CONTENT -->";
const TOC = "<!-- TOC -->";
const PAGER = "<!-- PAGER -->";
const LATEST_RELEASE = "<!-- LATEST_RELEASE -->";

/** Copied into dist-site/ beside the pages; each must exist. */
const ASSETS = ["favicon.svg", ".nojekyll", "site.css", "site.js"] as const;

const read = (path: string): string => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const stripTags = (html: string): string => html.replace(/<[^>]*>/g, "");

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

const NAV = /<nav class="nav"[\s\S]*?<\/nav>/;

/**
 * Fails unless the page's `<nav class="nav">` links every docs page, and
 * nothing else local. Returns the pages in nav order, which is also the
 * previous/next reading order.
 */
function checkNav(html: string, pages: readonly string[], file: string): string[] {
  const nav = html.match(NAV)?.[0] ?? "";
  const order = [...nav.matchAll(/href="\.\/([\w-]+)\.html"/g)].map((m) => m[1] as string);
  const linked = new Set(order);
  const missing = pages.filter((page) => !linked.has(page));
  const stale = [...linked].filter((page) => page !== "index" && !pages.includes(page));
  if (missing.length > 0 || stale.length > 0 || linked.size !== order.length) {
    throw new Error(
      `${file}: nav is out of sync with docs/*.md (missing: ${missing.join(", ") || "none"}; ` +
        `no such page: ${stale.join(", ") || "none"}; each page once: ${linked.size === order.length})`,
    );
  }
  return order.filter((page) => page !== "index");
}

/** Marks the current page's nav link; fails unless exactly one link matches. */
function markCurrent(html: string, name: string, file: string): string {
  const nav = html.match(NAV)?.[0] ?? "";
  const plain = `<a href="./${name}.html">`;
  const marked = fillOnce(nav, plain, `<a href="./${name}.html" aria-current="page">`, file);
  return html.replace(nav, () => marked);
}

/** Fails if the page would load anything (script, style, image, frame) from another origin. */
function checkNoExternalResources(text: string, file: string): void {
  const tag =
    /<(?:script|img|iframe|source|video|audio|embed|object|link)\b[^>]*\s(?:src|href|data|srcset)="(?:https?:)?\/\/[^"]*"/i.exec(
      text,
    );
  const cssUrl = /url\(\s*['"]?(?:https?:)?\/\//i.exec(text);
  const cssImport = /@import\s+(?:url\()?\s*['"]?(?:https?:)?\/\//i.exec(text);
  const hit = tag ?? cssUrl ?? cssImport;
  if (hit) throw new Error(`${file}: loads a resource from another origin: ${hit[0]}`);
}

/** The first sentence of a paragraph, as plain text, cut to a search-snippet length. */
function describe(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.split(/(?<=[.!?])\s/, 1)[0] ?? flat;
  if (sentence.length <= 200) return sentence;
  return `${sentence.slice(0, sentence.lastIndexOf(" ", 199))}…`;
}

const compareVersions = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

interface Heading {
  depth: 2 | 3;
  id: string;
  html: string;
}

interface RenderedPage {
  /** The H1 as plain text, for `<title>` and the doc-card check. */
  title: string;
  description: string;
  /** The hero (H1 and lead paragraph) plus the page body. */
  content: string;
  headings: Heading[];
  ids: Set<string>;
  /** Links to headings: [target page, anchor] pairs to validate once every page is rendered. */
  anchors: Array<[string, string]>;
}

function renderPage(name: string, pages: readonly string[]): RenderedPage {
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
  const headings: Heading[] = [];

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
        const inner = this.parser.parseInline(tokens);
        if (depth !== 2 && depth !== 3) return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
        const legacy = legacySlug(text);
        if (legacy !== "" && legacy !== id) legacyIds.set(id, legacy);
        // A link inside a heading would nest in the contents list's own link.
        headings.push({ depth, id, html: inner.replace(/<\/?a\b[^>]*>/g, "") });
        // The permalink sits beside the heading, not inside it, so the
        // heading's accessible name stays its own text.
        return (
          `<div class="heading"><h${depth} id="${id}">${inner}</h${depth}>` +
          `<a class="anchor" href="#${id}" aria-label="Link To This Section: ${escapeHtml(text)}">#</a></div>\n`
        );
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
  const titleHtml = parser.parseInline(h1.tokens);
  let dek = "";
  let dekText = "";
  let bodyAt = next(h1At + 1);
  const lead = tokens[bodyAt] as Tokens.Blockquote | undefined;
  if (lead?.type === "blockquote") {
    const [para] = lead.tokens;
    if (para?.type === "paragraph") {
      const { tokens: inline } = para as Tokens.Paragraph;
      dek = parser.parseInline(inline);
      dekText = parser.parseInline(inline, parser.textRenderer);
    }
    bodyAt = next(bodyAt + 1);
  }
  tokens.splice(0, bodyAt);

  // A hand-written contents list is dropped: the build generates one.
  const isToc = (t: Token): boolean =>
    t.type === "heading" &&
    (t as Tokens.Heading).depth === 2 &&
    /^(?:table of )?contents$/i.test(t.text);
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

  // Without a lead blockquote, the description comes from the first paragraph.
  if (dekText === "") {
    const para = tokens.find((t) => t.type === "paragraph") as Tokens.Paragraph | undefined;
    if (para) dekText = parser.parseInline(para.tokens, parser.textRenderer);
  }
  const description = describe(dekText);
  if (description === "") throw new Error(`${file}: no paragraph to describe the page with`);

  // Legacy aliases go in only once every real id is known, so an alias can
  // never shadow a heading that appears later on the page. Code blocks and
  // tables scroll inside themselves, so each is a keyboard stop.
  const aliased = new Set<string>();
  const body = marked
    .parser(tokens)
    .replaceAll("<table>", '<div class="tablewrap" tabindex="0"><table>')
    .replaceAll("</table>", "</table></div>")
    .replaceAll("<pre>", '<div class="code"><pre tabindex="0">')
    .replaceAll("</pre>", "</pre></div>")
    .replace(/<h[23] id="([^"]+)">/g, (open, id: string) => {
      const legacy = legacyIds.get(id);
      if (legacy === undefined || ids.has(legacy) || aliased.has(legacy)) return open;
      aliased.add(legacy);
      return `${open}<span id="${legacy}" class="legacy-anchor"></span>`;
    });
  const hero =
    `<header class="doc-hero">\n  <h1>${titleHtml}</h1>\n` +
    (dek ? `  <p class="dek">${dek}</p>\n` : "") +
    "</header>\n";
  const content = `${hero}<div class="prose">\n${body}</div>\n`;
  checkEmphasis(content, file);

  return { title, description, content, headings, ids, anchors };
}

/** The in-page contents list: h2 entries with their h3 entries nested under them. */
function renderToc(headings: readonly Heading[]): string {
  if (headings.length === 0) return "";
  const groups: Array<{ head: Heading; subs: Heading[] }> = [];
  for (const heading of headings) {
    const last = groups.at(-1);
    if (heading.depth === 3 && last) last.subs.push(heading);
    else groups.push({ head: heading, subs: [] });
  }
  const item = ({ id, html }: Heading): string => `<a href="#${id}">${html}</a>`;
  const list = groups
    .map(({ head, subs }) => {
      const nested = subs.length
        ? `\n<ol>\n${subs.map((sub) => `<li>${item(sub)}</li>`).join("\n")}\n</ol>\n`
        : "";
      return `<li>${item(head)}${nested}</li>`;
    })
    .join("\n");
  return (
    '<nav class="toc" aria-label="On This Page">\n<details>\n<summary>On This Page</summary>\n' +
    `<ol>\n${list}\n</ol>\n</details>\n</nav>`
  );
}

/** Previous and next links, in the nav's reading order. */
function renderPager(name: string, order: readonly string[], titles: Map<string, string>): string {
  const at = order.indexOf(name);
  const link = (page: string | undefined, rel: "prev" | "next"): string => {
    if (page === undefined) return "";
    const dir = rel === "prev" ? "Previous" : "Next";
    const title = escapeHtml(titles.get(page) ?? page);
    return `<a href="./${page}.html" rel="${rel}"><span class="dir">${dir}</span><span class="title">${title}</span></a>`;
  };
  const links = link(order[at - 1], "prev") + link(order[at + 1], "next");
  return links ? `<nav class="pager" aria-label="Previous And Next Pages">${links}</nav>` : "";
}

/**
 * The landing page's doc cards each name their page by its H1. Fails unless
 * every page has exactly one card and each card's title is that H1.
 */
function checkDocCards(index: string, titles: Map<string, string>, file: string): void {
  const cards = [...index.matchAll(/<a href="\.\/([\w-]+)\.html"><strong>([\s\S]*?)<\/strong>/g)];
  const problems: string[] = [];
  for (const [page, title] of titles) {
    const mine = cards.filter((card) => card[1] === page);
    const shown = mine[0] ? stripTags(mine[0][2] ?? "").trim() : "";
    if (mine.length !== 1) problems.push(`${page}: ${mine.length} cards`);
    else if (shown !== escapeHtml(title))
      problems.push(`${page}: card says "${shown}", H1 is "${title}"`);
  }
  if (problems.length > 0)
    throw new Error(`${file}: doc cards out of sync:\n  ${problems.join("\n  ")}`);
}

/**
 * The latest release: package.json's version, dated by its CHANGELOG.md
 * heading. Also checks the landing page's proposed next version (its one
 * `<data value>`) is newer than that release and not yet a CHANGELOG release.
 */
function latestRelease(index: string, file: string): string {
  const changelog = read(join(root, "CHANGELOG.md"));
  const { version } = pkg;
  const dated = new RegExp(`^## \\[${RegExp.escape(version)}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m");
  const date = changelog.match(dated)?.[1];
  if (date === undefined) {
    throw new Error(
      `CHANGELOG.md: no "## [${version}] - YYYY-MM-DD" heading for package.json's version`,
    );
  }
  const proposed = [...index.matchAll(/<data value="(\d+\.\d+\.\d+)">/g)].map(
    (m) => m[1] as string,
  );
  if (proposed.length !== 1) {
    throw new Error(
      `${file}: expected exactly one <data value="x.y.z"> next version, found ${proposed.length}`,
    );
  }
  const [nextVersion = ""] = proposed;
  if (compareVersions(nextVersion, version) <= 0) {
    throw new Error(
      `${file}: proposed version ${nextVersion} is not newer than the release ${version}`,
    );
  }
  if (!/^## \[Unreleased\]$/m.test(changelog) || changelog.includes(`## [${nextVersion}]`)) {
    throw new Error(
      `${file}: the hero says ${nextVersion} is unreleased work, but CHANGELOG.md has no [Unreleased] section or already releases it`,
    );
  }
  const tag = `v${escapeHtml(version)}`;
  return `<a href="${REPO}/releases/tag/${tag}">${tag}</a>, published <time datetime="${date}">${date}</time>`;
}

const pages = readdirSync(docsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => basename(entry.name, ".md"))
  .sort();
if (pages.length === 0) throw new Error("docs/: no pages found");

const missingAssets = ASSETS.filter((asset) => !existsSync(join(siteDir, asset)));
if (missingAssets.length > 0) throw new Error(`site/: missing ${missingAssets.join(", ")}`);
for (const asset of ["site.css", "site.js", "favicon.svg"]) {
  checkNoExternalResources(read(join(siteDir, asset)), `site/${asset}`);
}

const template = read(join(siteDir, "_template.html"));
const index = read(join(siteDir, "index.html"));
const order = checkNav(template, pages, "site/_template.html");
checkNav(index, pages, "site/index.html");

const rendered = new Map(pages.map((page) => [page, renderPage(page, pages)]));
const titles = new Map([...rendered].map(([page, { title }]) => [page, title]));

// Every heading anchor a page links to must exist on the target page.
const broken = [...rendered].flatMap(([page, { anchors }]) =>
  anchors
    .filter(([target, id]) => !rendered.get(target)?.ids.has(id))
    .map(([target, id]) => `  docs/${page}.md -> ${target}.md#${id}`),
);
if (broken.length > 0) {
  throw new Error(`Broken heading anchors:\n${broken.join("\n")}`);
}

checkDocCards(index, titles, "site/index.html");
const indexHtml = fillOnce(
  index,
  LATEST_RELEASE,
  latestRelease(index, "site/index.html"),
  "site/index.html",
);
checkNoExternalResources(indexHtml, "site/index.html");

// The content goes in last, so text in a doc can never be mistaken for a
// placeholder of the shell.
const output = new Map(
  [...rendered].map(([page, { title, description, content, headings }]) => {
    const file = "site/_template.html";
    let html = fillOnce(template, TITLE, escapeHtml(title), file);
    html = fillOnce(html, DESCRIPTION, escapeHtml(description), file);
    html = fillOnce(html, EDIT_URL, `${EDIT}docs/${page}.md`, file);
    html = fillOnce(html, TOC, renderToc(headings), file);
    html = fillOnce(html, PAGER, renderPager(page, order, titles), file);
    html = markCurrent(html, page, file);
    html = fillOnce(html, CONTENT, content, file);
    checkNoExternalResources(html, `dist-site/${page}.html`);
    return [page, html];
  }),
);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const [page, html] of output) writeFileSync(join(outDir, `${page}.html`), html);
writeFileSync(join(outDir, "index.html"), indexHtml);
for (const asset of ASSETS) copyFileSync(join(siteDir, asset), join(outDir, asset));

console.log(
  `dist-site/: index.html + ${pages.length} pages (${pages.join(", ")}) at v${pkg.version}`,
);
