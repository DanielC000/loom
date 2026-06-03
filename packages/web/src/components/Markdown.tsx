import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

// Read-only Obsidian-flavored markdown renderer for the vault viewer (§7: no editing).
// Supports GFM (tables, task lists, strikethrough) plus Obsidian extensions:
//   - [[wikilinks]] / [[target|alias]]  → internal links that open the target note
//   - ![[embeds]]                       → an embed chip that opens the target note
//   - > [!type] callouts                → styled callout boxes
//   - YAML frontmatter                  → a compact properties panel (not raw source)

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

/** Rewrite [[wikilinks]] and ![[embeds]] to markdown links with custom URI schemes. */
function transformWikilinks(body: string): string {
  return outsideCode(body, (text) =>
    text
      .replace(/!\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
        const [target, alias] = inner.split("|");
        const label = (alias ?? target ?? "").trim() || (target ?? "").trim();
        return `[${label}](wikiembed:${encodeURIComponent((target ?? "").trim())})`;
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

export default function Markdown({ source, files, currentPath = "", onOpen }: { source: string; files: string[]; currentPath?: string; onOpen: (path: string) => void }) {
  const { props, body } = splitFrontmatter(source);
  const transformed = transformWikilinks(body);

  const components: Components = {
    a({ href, children }) {
      const h = typeof href === "string" ? href : "";
      if (h.startsWith("wikilink:") || h.startsWith("wikiembed:")) {
        const embed = h.startsWith("wikiembed:");
        const path = resolveWiki(h.slice(h.indexOf(":") + 1), files);
        const cls = `${embed ? "md-embed" : "md-wikilink"}${path ? "" : " md-broken"}`;
        const label = embed ? <>⧉ {children}</> : children;
        if (path) return <a className={cls} href="#" onClick={(e) => { e.preventDefault(); onOpen(path); }}>{label}</a>;
        return <span className={cls} title="unresolved link">{label}</span>;
      }
      // True external links (http/https/mailto/…) open normally in a new tab.
      if (isExternalHref(h)) return <a href={h} target="_blank" rel="noreferrer">{children}</a>;
      // In-page anchors (`#heading`) stay default — same doc, browser scrolls.
      if (h.startsWith("#")) return <a href={h}>{children}</a>;
      // Otherwise it's a relative in-vault link: resolve it to a vault file and open it in the pane,
      // instead of letting the browser navigate the SPA to a dead `/<href>` route.
      const path = resolveRelative(h, currentPath, files);
      if (path) return <a className="md-wikilink" href="#" onClick={(e) => { e.preventDefault(); onOpen(path); }}>{children}</a>;
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
  };

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
        urlTransform={(url) => (url.startsWith("wikilink:") || url.startsWith("wikiembed:") ? url : defaultUrlTransform(url))}
        components={components}
      >{transformed}</ReactMarkdown>
    </div>
  );
}

const MD_CSS = `
.loom-md { color: #e6e6e6; font-size: 14px; line-height: 1.6; word-wrap: break-word; }
.loom-md h1, .loom-md h2, .loom-md h3, .loom-md h4 { color: #fff; line-height: 1.3; margin: 1.2em 0 0.5em; }
.loom-md h1 { font-size: 1.7em; border-bottom: 1px solid #2a2a2e; padding-bottom: 0.2em; }
.loom-md h2 { font-size: 1.4em; border-bottom: 1px solid #2a2a2e; padding-bottom: 0.2em; }
.loom-md h3 { font-size: 1.2em; } .loom-md h4 { font-size: 1.05em; }
.loom-md p { margin: 0.6em 0; }
.loom-md a { color: #9ad; text-decoration: none; } .loom-md a:hover { text-decoration: underline; }
.loom-md ul, .loom-md ol { padding-left: 1.6em; margin: 0.5em 0; }
.loom-md li { margin: 0.2em 0; }
.loom-md code { background: #161618; border: 1px solid #2a2a2e; border-radius: 4px; padding: 0.1em 0.35em; font-family: ui-monospace, Consolas, monospace; font-size: 0.9em; }
.loom-md pre { background: #161618; border: 1px solid #2a2a2e; border-radius: 6px; padding: 12px; overflow: auto; }
.loom-md pre code { background: none; border: none; padding: 0; }
.loom-md blockquote { border-left: 3px solid #3a3a40; margin: 0.6em 0; padding: 0.1em 0 0.1em 1em; color: #b9b9bf; }
.loom-md table { border-collapse: collapse; margin: 0.6em 0; }
.loom-md th, .loom-md td { border: 1px solid #2a2a2e; padding: 5px 10px; }
.loom-md th { background: #161618; color: #fff; }
.loom-md hr { border: none; border-top: 1px solid #2a2a2e; margin: 1.2em 0; }
.loom-md img { max-width: 100%; }
.loom-md .md-props { border-collapse: collapse; margin-bottom: 1em; background: #131316; border: 1px solid #2a2a2e; border-radius: 6px; }
.loom-md .md-props-k { color: #9aa; padding: 3px 12px; font-size: 12px; vertical-align: top; white-space: nowrap; }
.loom-md .md-props-v { color: #ddd; padding: 3px 12px; font-size: 12px; }
.loom-md .md-wikilink { color: #b39ddb; cursor: pointer; }
.loom-md .md-embed { display: inline-block; color: #9ad; cursor: pointer; background: #161618; border: 1px solid #2a2a2e; border-radius: 4px; padding: 0 6px; font-size: 0.92em; }
.loom-md .md-broken { color: #c77; cursor: default; text-decoration: none; }
.loom-md .md-callout { border: 1px solid #2a2a2e; border-left: 4px solid #5a8dee; border-radius: 6px; padding: 8px 12px; margin: 0.8em 0; background: rgba(90,141,238,0.07); }
.loom-md .md-callout-title { font-weight: 600; color: #fff; margin-bottom: 0.2em; }
.loom-md .md-callout-body > :first-child { margin-top: 0; } .loom-md .md-callout-body > :last-child { margin-bottom: 0; }
.loom-md .md-callout-tip, .loom-md .md-callout-success, .loom-md .md-callout-hint, .loom-md .md-callout-done { border-left-color: #4caf6a; background: rgba(76,175,106,0.07); }
.loom-md .md-callout-warning, .loom-md .md-callout-caution, .loom-md .md-callout-attention { border-left-color: #e0a72e; background: rgba(224,167,46,0.07); }
.loom-md .md-callout-danger, .loom-md .md-callout-error, .loom-md .md-callout-bug, .loom-md .md-callout-failure { border-left-color: #e05a5a; background: rgba(224,90,90,0.07); }
.loom-md .md-callout-question, .loom-md .md-callout-help, .loom-md .md-callout-faq, .loom-md .md-callout-example { border-left-color: #a36ce0; background: rgba(163,108,224,0.07); }
.loom-md .md-callout-quote, .loom-md .md-callout-cite, .loom-md .md-callout-abstract, .loom-md .md-callout-summary { border-left-color: #8a8a92; background: rgba(138,138,146,0.07); }
`;
