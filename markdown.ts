/**
 * A small markdown renderer for the prose the model returns: paragraphs, headings,
 * bulleted and numbered lists, fenced and inline code, bold, italic, links. It builds
 * DOM nodes — nothing the model wrote ever goes through `innerHTML` — and links open
 * in a new tab. Anything it does not know stays as text.
 */

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; text: string; lang: string }
  | { kind: "quote"; text: string };

/** Split markdown into blocks. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const flushPara = (buf: string[]) => { if (buf.length) out.push({ kind: "p", text: buf.join(" ").trim() }); };
  let para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*(\w*)\s*$/.exec(line);
    if (fence) {
      flushPara(para); para = [];
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push({ kind: "code", text: code.join("\n"), lang: fence[1] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushPara(para); para = []; out.push({ kind: "h", level: heading[1].length, text: heading[2].trim() }); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara(para); para = [];
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*[-*+]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i])) { item += " " + lines[i].trim(); i++; }
        items.push(item);
      }
      out.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara(para); para = [];
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*\d+[.)]\s+/, "");
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) { item += " " + lines[i].trim(); i++; }
        items.push(item);
      }
      out.push({ kind: "ol", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(para); para = [];
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push({ kind: "quote", text: q.join(" ") });
      continue;
    }
    if (line.trim() === "") { flushPara(para); para = []; i++; continue; }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
  return out;
}

export type Span = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "b"; spans: Span[] } | { kind: "i"; spans: Span[] } | { kind: "a"; href: string; spans: Span[] };

/** Inline markup within a block: `code`, **bold**, *italic* / _italic_, [text](url). */
export function parseSpans(text: string): Span[] {
  const out: Span[] = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { out.push({ kind: "text", text: buf }); buf = ""; } };
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) { flush(); out.push({ kind: "code", text: m[1] }); i += m[0].length; continue; }
    if ((m = /^\*\*(.+?)\*\*/.exec(rest))) { flush(); out.push({ kind: "b", spans: parseSpans(m[1]) }); i += m[0].length; continue; }
    if ((m = /^(?:\*(?!\s)([^*]+?)\*|_(?!\s)([^_]+?)_)(?![\w])/.exec(rest))) { flush(); out.push({ kind: "i", spans: parseSpans(m[1] ?? m[2]) }); i += m[0].length; continue; }
    if ((m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(rest))) { flush(); out.push({ kind: "a", href: m[2], spans: parseSpans(m[1]) }); i += m[0].length; continue; }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

function spanNodes(spans: Span[]): Node[] {
  return spans.map((s) => {
    switch (s.kind) {
      case "text": return document.createTextNode(s.text);
      case "code": { const el = document.createElement("code"); el.textContent = s.text; return el; }
      case "b": { const el = document.createElement("strong"); el.append(...spanNodes(s.spans)); return el; }
      case "i": { const el = document.createElement("em"); el.append(...spanNodes(s.spans)); return el; }
      case "a": { const el = document.createElement("a"); el.href = s.href; el.target = "_blank"; el.rel = "noopener noreferrer"; el.append(...spanNodes(s.spans)); return el; }
    }
  });
}

/** Markdown → a `<div>` of elements. Safe for text the model wrote. */
export function renderMarkdown(md: string): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "ai-md";
  for (const b of parseBlocks(md)) {
    switch (b.kind) {
      case "p": { const p = document.createElement("p"); p.append(...spanNodes(parseSpans(b.text))); root.append(p); break; }
      case "h": { const h = document.createElement(`h${Math.min(6, b.level + 2)}` as "h3"); h.append(...spanNodes(parseSpans(b.text))); root.append(h); break; }
      case "ul":
      case "ol": {
        const list = document.createElement(b.kind);
        for (const item of b.items) { const li = document.createElement("li"); li.append(...spanNodes(parseSpans(item))); list.append(li); }
        root.append(list);
        break;
      }
      case "code": { const pre = document.createElement("pre"); const code = document.createElement("code"); code.textContent = b.text; if (b.lang) code.dataset.lang = b.lang; pre.append(code); root.append(pre); break; }
      case "quote": { const q = document.createElement("blockquote"); q.append(...spanNodes(parseSpans(b.text))); root.append(q); break; }
    }
  }
  return root;
}

/** Plain text of markdown, for a title or a status line. */
export function plainText(md: string): string {
  return parseBlocks(md).map((b) => ("text" in b ? b.text : b.items.join(" "))).join(" ").replace(/[`*_]/g, "").trim();
}
