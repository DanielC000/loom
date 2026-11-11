import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

// Read-only Obsidian-flavored markdown renderer for the vault viewer (§7: no editing).
// Supports GFM (tables, task lists, strikethrough) plus Obsidian extensions:
//   - [[wikilinks]] / [[target|alias]]  → internal links that open the target note
//   - ![[embeds]]                       → an embed chip that opens the target note
//   - > [!type] callouts                → styled callout boxes
//   - YAML frontmatter                  → a compact properties panel (not raw source)

/**
 * Bridges the in-doc find bar (which lives in the Vault page, OUTSIDE this renderer) to the
 * collapsible sections below. Each {@link CollapsibleSection} registers its `<section>` element →
 * an expander, so when find navigates to a match buried in a collapsed section it can open every
 * collapsed ancestor first. The Vault page owns the registry Map and provides it; sections consume it.
 */
export const CollapseContext = createContext<Map<HTMLElement, () => void> | null>(null);

/** Split leading YAML frontmatter into key/value lines + the remaining body. */
function splitFrontmatter(src: string): { props: Array<[string, string]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { props: [], body: src };
  const props = (m[1] ?? "")
    .split(/\r?\n/)
    .map((line): [string, string] | null => {
      const i = line.indexOf(":");
      return i === -1 ? null : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    })
    .filter((x): x is [string, string] => x !== null && x[0].length > 0);
  return { props, body: src.slice(m[0].length) };
}

/** Run `fn` only on text OUTSIDE fenced/inline code spans, so wikilinks in code are left alone. */
function outsideCode(src: string, fn: (s: string) => string): string {
  return src
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 0 ? fn(seg) : seg))
    .join("");
}

/** Extensions we render as an inline <img> (matches the daemon raw endpoint's image content-types). */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i;
const isImageTarget = (t: string): boolean => IMAGE_EXT.test((t.split("#")[0] ?? "").trim());
const baseName = (p: string): string => p.split("/").pop() ?? p;

/** Rewrite [[wikilinks]] and ![[embeds]] to markdown links with custom URI schemes. */
function transformWikilinks(body: string): string {
  return outsideCode(body, (text) =>
    text
      .replace(/!\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
        const [target, alias] = inner.split("|");
        const t = (target ?? "").trim();
        const label = (alias ?? "").trim() || t;
        // ![[image.png]] → a real markdown image (the `!` makes react-markdown emit an <img> node we
        // resolve to the raw endpoint); ![[note]] stays an embed chip link that opens the target note.
        return isImageTarget(t)
          ? `![${label}](wikiembed:${encodeURIComponent(t)})`
          : `[${label}](wikiembed:${encodeURIComponent(t)})`;
      })
      .replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
        const [target, alias] = inner.split("|");
        const label = (alias ?? target ?? "").trim() || (target ?? "").trim();
        return `[${label}](wikilink:${encodeURIComponent((target ?? "").trim())})`;
      }),
  );
}

/** remark plugin: turn `> [!type] title` blockquotes into styled callout <div>s. */
function remarkCallouts() {
  return (tree: unknown) => {
    visit(tree as never, "blockquote", (node: any) => {
      const para = node.children?.[0];
      const firstText = para?.type === "paragraph" ? para.children?.[0] : undefined;
      if (!firstText || firstText.type !== "text") return;
      const m = /^\[!(\w+)\]([+-]?)\s*(.*)$/m.exec(firstText.value);
      if (!m) return;
      const type = (m[1] ?? "note").toLowerCase();
      const title = (m[3] ?? "").trim() || (m[1] ?? "Note");
      // Drop the marker line from the body; if the first text/paragraph is now empty, remove it.
      firstText.value = firstText.value.replace(/^\[!\w+\][+-]?\s*.*(\r?\n)?/, "");
      if (!firstText.value && para.children.length === 1) node.children.shift();
      node.data = {
        hName: "div",
        hProperties: { className: `md-callout md-callout-${type}`, "data-title": title },
      };
    });
  };
}

/**
 * rehype plugin: wrap each heading + the content that follows it into a `<section class="md-section">`,
 * nested by header level so a higher-level header's section CONTAINS the lower-level sections beneath it.
 * This is what makes collapse boundaries correct: collapsing an h2 hides everything down to the next
 * h2-or-higher (including its nested h3s), while collapsing one of those h3s only hides that h3's body.
 * Content before the first heading stays at the root, ungrouped.
 */
function rehypeCollapsibleSections() {
  const headingLevel = (n: any): number =>
    n?.type === "element" && typeof n.tagName === "string" && /^h[1-6]$/.test(n.tagName) ? Number(n.tagName.slice(1)) : 0;
  return (tree: any) => {
    const out: any[] = [];
    const stack: Array<{ level: number; section: any }> = [];
    const append = (node: any) => {
      const top = stack[stack.length - 1];
      (top ? top.section.children : out).push(node);
    };
    for (const node of (tree?.children ?? []) as any[]) {
      const level = headingLevel(node);
      if (level > 0) {
        while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
        const section = {
          type: "element",
          tagName: "section",
          properties: { className: ["md-section"] },
          children: [node],
        };
        append(section);
        stack.push({ level, section });
      } else {
        append(node);
      }
    }
    tree.children = out;
  };
}

/** Small caret that rotates from ▸ (collapsed) to ▾ (open), matching the vault tree's chevron. */
function CollapseChevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 10 10" aria-hidden
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms ease" }}>
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A header section emitted by {@link rehypeCollapsibleSections}: its first child is the heading, the rest
 * is the section body. A keyboard-accessible chevron toggle is injected into the heading; collapsing
 * HIDES the body via CSS (`[data-collapsed] > :not(:first-child)`) rather than unmounting it — so the
 * body's text nodes stay in the DOM and the in-doc find bar can locate matches inside a collapsed section
 * (then expand it to reveal them). Clicking the heading text toggles too (but not when a link is clicked).
 * The `<section>` registers itself into {@link CollapseContext} so find can expand it programmatically.
 */
function CollapsibleSection({ level, children }: { level: number; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const registry = useContext(CollapseContext);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !registry) return;
    registry.set(el, () => setCollapsed(false));
    return () => { registry.delete(el); };
  }, [registry]);
  const toggle = () => setCollapsed((c) => !c);
  const items = Children.toArray(children);
  const heading = items[0];
  const body = items.slice(1);

  const headingEl = isValidElement(heading) ? (heading as ReactElement<any>) : null;
  const headingWithToggle = headingEl
    ? cloneElement(
        headingEl,
        {
          className: `${headingEl.props.className ? `${headingEl.props.className} ` : ""}md-heading-collapsible`,
          "data-collapsed": collapsed ? "true" : "false",
          onClick: (e: ReactMouseEvent) => { if (!(e.target as HTMLElement).closest("a")) toggle(); },
        },
        <button key="md-collapse" type="button" className="md-collapse-toggle"
          aria-expanded={!collapsed} aria-label={collapsed ? "Expand section" : "Collapse section"}
          onClick={(e) => { e.stopPropagation(); toggle(); }}>
          <CollapseChevron open={!collapsed} />
        </button>,
        ...Children.toArray(headingEl.props.children),
      )
    : heading;

  return (
    <section ref={sectionRef} className="md-section" data-level={level} data-collapsed={collapsed ? "true" : "false"}>
      {headingWithToggle}
      {body}
    </section>
  );
}

function resolveWiki(rawTarget: string, files: string[]): string | null {
  const target = decodeURIComponent(rawTarget).split("#")[0]?.split("|")[0]?.trim() ?? "";
  if (!target) return null;
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  const t = norm(target);
  const exact = files.find((f) => norm(f) === t || norm(f) === `${t}.md`);
  if (exact) return exact;
  const wanted = t.split("/").pop();
  const base = (f: string) => (norm(f).split("/").pop() ?? "").replace(/\.md$/, "");
  return files.find((f) => base(f) === wanted) ?? null;
}

/** True for links the browser should open normally (URL scheme like http:/mailto:, or protocol-relative). */
function isExternalHref(h: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith("//");
}

/**
 * Resolve a relative in-vault link (e.g. `README.md`, `../notes/x.md`) against the directory of the
 * currently-open doc, then match it to a known vault file. Falls back to a basename match like
 * resolveWiki so links written without the full path still land.
 */
function resolveRelative(href: string, currentPath: string, files: string[]): string | null {
  const raw = decodeURIComponent((href.split("#")[0] ?? "").split("?")[0] ?? "").trim();
  if (!raw) return null;
  const norm = (s: string) => s.replace(/\\/g, "/");
  const lower = (s: string) => norm(s).toLowerCase();
  const stack = raw.startsWith("/") ? [] : norm(currentPath).split("/").slice(0, -1);
  for (const seg of norm(raw).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const resolved = lower(stack.join("/"));
  if (!resolved) return null;
  const exact = files.find((f) => lower(f) === resolved || lower(f) === `${resolved}.md`);
  if (exact) return exact;
  const wanted = (stack[stack.length - 1] ?? "").toLowerCase().replace(/\.md$/, "");
  const base = (f: string) => (lower(f).split("/").pop() ?? "").replace(/\.md$/, "");
  return files.find((f) => base(f) === wanted) ?? null;
}

/**
 * An off-host image, BLOCKED until the reader asks for it. An `<img src>` to an arbitrary host is a read
 * beacon, and every surface this renderer serves can carry agent-written bytes (vault notes included), so
 * nothing is fetched on render. The button loads THIS image only, for this mount only: no persistence, no
 * per-host memory, so reopening the note blocks it again. The URL stays in the title so the reader sees
 * what they are about to load.
 * @decision 86ea3ea6 — blocked is the default for every caller; never auto-load, never remember a click.
 */
function ExternalImage({ src, alt }: { src: string; alt: string }) {
  const [load, setLoad] = useState(false);
  if (load) return <img className="md-img" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
  return (
    <span className="md-ext-img" title={`External image not loaded: ${src}`}>
      image not loaded · {alt || "untitled"}
      <button type="button" className="md-ext-img-load" onClick={() => setLoad(true)}
        aria-label={`Load external image${alt ? ` "${alt}"` : ""} from ${src}`} title={`Load ${src}`}>
        Load
      </button>
    </span>
  );
}

/**
 * Agent bytes stay inert for every caller: raw HTML is never rendered (no `rehype-raw`, so
 * `<script>`/`on*` attributes never reach the DOM), and `defaultUrlTransform` empties a
 * `javascript:`/`data:` URL, which then renders as an unresolved span. External images are blocked by
 * default ({@link ExternalImage}); `allowExternalImages` is the explicit opt-in for a caller whose source
 * is known not to be agent-written (no caller needs it today).
 */
export default function Markdown({ source, files, currentPath = "", onOpen, AssetImage, allowExternalImages = false }: { source: string; files: string[]; currentPath?: string; onOpen: (path: string) => void; AssetImage?: ComponentType<{ path: string; alt: string; className?: string }>; allowExternalImages?: boolean }) {
  const { props, body } = splitFrontmatter(source);
  const transformed = transformWikilinks(body);

  // `onOpen` is read through a ref so a caller passing a fresh arrow each render (the common case)
  // cannot defeat the memo below. Assigned during render on purpose: a click handler must see the
  // CURRENT callback, not last commit's.
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // MEMOISED, and it is load-bearing rather than tidiness: react-markdown uses each entry here as the
  // ELEMENT TYPE, so rebuilding this object gives every rendered node a new type and React remounts the
  // lot on any re-render of this component. That was invisible while an inline image was a plain
  // `<img src>`, but `AssetImage` can fetch its own bytes (card f7525818) — a remount then re-fetches
  // every image in the note on, say, each keystroke in an unrelated filter box elsewhere on the page.
  // packages/web/e2e/vault-remote-assets.spec.ts pins that fetch count, so an unstable dep fails loudly.
  const components: Components = useMemo(() => ({
    // Inline images: ![[image.png]] embeds (wikiembed: scheme) and standard ![](relative) images both
    // resolve to a vault file, then render through the caller's `AssetImage`. That is a COMPONENT, not a
    // `(path) => string`, because resolving a vault asset can need an authenticated fetch on a remote
    // origin (card f7525818) — a URL-returning callback cannot express that, a component can.
    // External http(s) images are blocked behind a click-to-load placeholder unless the caller opted in.
    img({ src, alt }) {
      const s = typeof src === "string" ? src : "";
      const altText = typeof alt === "string" ? alt : "";
      if (s.startsWith("wikiembed:")) {
        const target = s.slice("wikiembed:".length);
        const path = resolveWiki(target, files);
        if (path && AssetImage) return <AssetImage className="md-img" path={path} alt={altText || baseName(path)} />;
        return <span className="md-broken" title="unresolved image">{altText || decodeURIComponent(target)}</span>;
      }
      if (isExternalHref(s)) {
        return allowExternalImages
          ? <img className="md-img" src={s} alt={altText} loading="lazy" />
          : <ExternalImage src={s} alt={altText} />;
      }
      const path = resolveRelative(s, currentPath, files);
      if (path && AssetImage) return <AssetImage className="md-img" path={path} alt={altText || baseName(path)} />;
      return <span className="md-broken" title="unresolved image">{altText || s}</span>;
    },
    a({ href, children }) {
      const h = typeof href === "string" ? href : "";
      if (h.startsWith("wikilink:") || h.startsWith("wikiembed:")) {
        const embed = h.startsWith("wikiembed:");
        const path = resolveWiki(h.slice(h.indexOf(":") + 1), files);
        const cls = `${embed ? "md-embed" : "md-wikilink"}${path ? "" : " md-broken"}`;
        const label = embed ? <>⧉ {children}</> : children;
        if (path) return <a className={cls} href="#" onClick={(e) => { e.preventDefault(); onOpenRef.current(path); }}>{label}</a>;
        return <span className={cls} title="unresolved link">{label}</span>;
      }
      // True external links (http/https/mailto/…) open normally in a new tab.
      if (isExternalHref(h)) return <a href={h} target="_blank" rel="noopener noreferrer">{children}</a>;
      // In-page anchors (`#heading`) stay default — same doc, browser scrolls.
      if (h.startsWith("#")) return <a href={h}>{children}</a>;
      // Otherwise it's a relative in-vault link: resolve it to a vault file and open it in the pane,
      // instead of letting the browser navigate the SPA to a dead `/<href>` route.
      const path = resolveRelative(h, currentPath, files);
      if (path) return <a className="md-wikilink" href="#" onClick={(e) => { e.preventDefault(); onOpenRef.current(path); }}>{children}</a>;
      return <span className="md-broken" title="unresolved link">{children}</span>;
    },
    div({ className, children, ...rest }) {
      const cls = typeof className === "string" ? className : "";
      if (cls.includes("md-callout")) {
        const title = (rest as Record<string, unknown>)["data-title"];
        return (
          <div className={cls}>
            {typeof title === "string" && title ? <div className="md-callout-title">{title}</div> : null}
            <div className="md-callout-body">{children}</div>
          </div>
        );
      }
      return <div className={className}>{children}</div>;
    },
    // Header sections wrapped by rehypeCollapsibleSections → a collapsible block. Level is derived from
    // the wrapped heading's tag so the chevron/indent matches h1…h6.
    section({ node, className, children }) {
      const cls = typeof className === "string" ? className : "";
      if (!cls.includes("md-section")) return <section className={className}>{children}</section>;
      const head = node?.children.find((c) => c.type === "element");
      const level = head && head.type === "element" && /^h[1-6]$/.test(head.tagName) ? Number(head.tagName.slice(1)) : 1;
      return <CollapsibleSection level={level}>{children}</CollapsibleSection>;
    },
  }), [files, currentPath, AssetImage, allowExternalImages]);

  return (
    <div className="loom-md">
      <style>{MD_CSS}</style>
      {props.length > 0 && (
        <table className="md-props"><tbody>
          {props.map(([k, v]) => (<tr key={k}><td className="md-props-k">{k}</td><td className="md-props-v">{v}</td></tr>))}
        </tbody></table>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        rehypePlugins={[rehypeCollapsibleSections]}
        urlTransform={(url) => (url.startsWith("wikilink:") || url.startsWith("wikiembed:") ? url : defaultUrlTransform(url))}
        components={components}
      >{transformed}</ReactMarkdown>
    </div>
  );
}

const MD_CSS = `
.loom-md { color: var(--loom-text); font-size: 14px; line-height: 1.6; word-wrap: break-word; }
.loom-md h1, .loom-md h2, .loom-md h3, .loom-md h4 { color: var(--loom-text); line-height: 1.3; margin: 1.2em 0 0.5em; }
.loom-md h1 { font-size: 1.7em; border-bottom: 1px solid var(--loom-line); padding-bottom: 0.2em; }
.loom-md h2 { font-size: 1.4em; border-bottom: 1px solid var(--loom-line); padding-bottom: 0.2em; }
.loom-md h3 { font-size: 1.2em; } .loom-md h4 { font-size: 1.05em; }
.loom-md p { margin: 0.6em 0; }
.loom-md a { color: var(--loom-accent-fg); text-decoration: none; } .loom-md a:hover { text-decoration: underline; }
.loom-md ul, .loom-md ol { padding-left: 1.6em; margin: 0.5em 0; }
.loom-md li { margin: 0.2em 0; }
.loom-md code { background: var(--loom-inset); border: 1px solid var(--loom-line); border-radius: 4px; padding: 0.1em 0.35em; font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
.loom-md pre { background: var(--loom-inset); border: 1px solid var(--loom-line); border-radius: 6px; padding: 12px; overflow: auto; }
.loom-md pre code { background: none; border: none; padding: 0; }
.loom-md blockquote { border-left: 3px solid var(--loom-line-strong); margin: 0.6em 0; padding: 0.1em 0 0.1em 1em; color: var(--loom-text-2); }
.loom-md table { border-collapse: collapse; margin: 0.6em 0; }
.loom-md th, .loom-md td { border: 1px solid var(--loom-line); padding: 5px 10px; }
.loom-md th { background: var(--loom-inset); color: var(--loom-text); }
.loom-md hr { border: none; border-top: 1px solid var(--loom-line); margin: 1.2em 0; }
.loom-md img, .loom-md .md-img { max-width: 100%; }
.loom-md .md-img { display: block; max-height: 70vh; height: auto; margin: 0.6em 0; border: 1px solid var(--loom-line); border-radius: 6px; background: var(--loom-inset); }
.loom-md .md-props { border-collapse: collapse; margin-bottom: 1em; background: var(--loom-inset); border: 1px solid var(--loom-line); border-radius: 6px; }
.loom-md .md-props-k { color: var(--loom-text-3); padding: 3px 12px; font-size: 12px; vertical-align: top; white-space: nowrap; }
.loom-md .md-props-v { color: var(--loom-text); padding: 3px 12px; font-size: 12px; }
.loom-md .md-wikilink { color: var(--loom-md-wikilink); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.loom-md .md-embed { display: inline-block; color: var(--loom-accent-fg); cursor: pointer; background: var(--loom-inset); border: 1px solid var(--loom-line); border-radius: 4px; padding: 0 6px; font-size: 0.92em; }
.loom-md .md-broken { color: var(--loom-danger); cursor: default; text-decoration: none; }
.loom-md .md-ext-img { display: inline-block; color: var(--loom-text-3); background: var(--loom-inset); border: 1px dashed var(--loom-line-strong); border-radius: 4px; padding: 0 6px; font-size: 0.85em; font-family: ui-monospace, Consolas, monospace; }
.loom-md .md-ext-img-load {
  margin-left: 0.6em; padding: 0 0.45em; font: inherit; line-height: inherit; color: var(--loom-accent-fg);
  background: none; border: 1px solid var(--loom-line-strong); border-radius: 3px; cursor: pointer;
  -webkit-appearance: none; appearance: none;
}
.loom-md .md-ext-img-load:hover { color: var(--loom-text); border-color: var(--loom-accent-fg); }
.loom-md .md-ext-img-load:focus-visible { outline: 2px solid var(--loom-ring); outline-offset: 1px; }
.loom-md .md-callout { --md-callout: var(--loom-md-callout-note); border: 1px solid var(--loom-line); border-left: 4px solid var(--md-callout); border-radius: 6px; padding: 8px 12px; margin: 0.8em 0; background: color-mix(in oklab, var(--md-callout) 7%, transparent); }
.loom-md .md-callout-title { font-weight: 600; color: var(--loom-text); margin-bottom: 0.2em; }
.loom-md .md-callout-body > :first-child { margin-top: 0; } .loom-md .md-callout-body > :last-child { margin-bottom: 0; }
.loom-md .md-callout-tip, .loom-md .md-callout-success, .loom-md .md-callout-hint, .loom-md .md-callout-done { --md-callout: var(--loom-live); }
.loom-md .md-callout-warning, .loom-md .md-callout-caution, .loom-md .md-callout-attention { --md-callout: var(--loom-attn); }
.loom-md .md-callout-danger, .loom-md .md-callout-error, .loom-md .md-callout-bug, .loom-md .md-callout-failure { --md-callout: var(--loom-danger); }
.loom-md .md-callout-question, .loom-md .md-callout-help, .loom-md .md-callout-faq, .loom-md .md-callout-example { --md-callout: var(--loom-md-callout-question); }
.loom-md .md-callout-quote, .loom-md .md-callout-cite, .loom-md .md-callout-abstract, .loom-md .md-callout-summary { --md-callout: var(--loom-text-3); }
.loom-md .md-section { margin: 0; }
/* Collapsed: hide everything after the heading (the section body) without unmounting it, so the
   in-doc find bar can still see the text nodes and expand the section to reveal a match. */
.loom-md .md-section[data-collapsed="true"] > :not(:first-child) { display: none; }
/* In-doc find (CSS Custom Highlight API): all matches read as a quiet amber wash; the active match
   is a solid amber so prev/next is obvious. Names match the registry keys in DocFind.tsx. */
::highlight(loom-find) { background-color: color-mix(in oklab, var(--loom-attn) 30%, transparent); color: var(--loom-text); }
::highlight(loom-find-active) { background-color: var(--loom-attn); color: var(--loom-on-attn); }
.loom-md .md-heading-collapsible { cursor: pointer; }
.loom-md .md-collapse-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1em; height: 1em; margin-right: 0.34em; margin-left: -0.1em; padding: 0;
  vertical-align: -0.06em; background: none; border: none; border-radius: 3px;
  color: var(--loom-text-3); cursor: pointer; flex-shrink: 0; -webkit-appearance: none; appearance: none;
}
.loom-md .md-heading-collapsible:hover .md-collapse-toggle { color: var(--loom-text-2); }
.loom-md .md-collapse-toggle:focus-visible { outline: 2px solid var(--loom-ring); outline-offset: 1px; color: var(--loom-text-2); }
`;
