import { describe, expect, it } from "vitest";
import { parseBlocks, parseSpans, plainText } from "../markdown";

describe("parseBlocks", () => {
  it("splits headings, paragraphs, lists, code and quotes", () => {
    const blocks = parseBlocks(`# Title\n\nFirst para\ncontinues.\n\n- one\n- two\n  wrapped\n\n1. a\n2) b\n\n\`\`\`ts\nlet x = 1;\n\`\`\`\n\n> quoted\n> more\n`);
    expect(blocks).toEqual([
      { kind: "h", level: 1, text: "Title" },
      { kind: "p", text: "First para continues." },
      { kind: "ul", items: ["one", "two wrapped"] },
      { kind: "ol", items: ["a", "b"] },
      { kind: "code", text: "let x = 1;", lang: "ts" },
      { kind: "quote", text: "quoted more" },
    ]);
  });
  it("closes an unterminated fence at the end", () => {
    expect(parseBlocks("```\nabc")).toEqual([{ kind: "code", text: "abc", lang: "" }]);
  });
});

describe("parseSpans", () => {
  it("finds code, bold, italic and links, leaving the rest as text", () => {
    expect(parseSpans("a `b` **c** *d* _e_ [f](https://g) h*i")).toEqual([
      { kind: "text", text: "a " },
      { kind: "code", text: "b" },
      { kind: "text", text: " " },
      { kind: "b", spans: [{ kind: "text", text: "c" }] },
      { kind: "text", text: " " },
      { kind: "i", spans: [{ kind: "text", text: "d" }] },
      { kind: "text", text: " " },
      { kind: "i", spans: [{ kind: "text", text: "e" }] },
      { kind: "text", text: " " },
      { kind: "a", href: "https://g", spans: [{ kind: "text", text: "f" }] },
      { kind: "text", text: " h*i" },
    ]);
  });
  it("does not link javascript: urls", () => {
    expect(parseSpans("[x](javascript:alert(1))")).toEqual([{ kind: "text", text: "[x](javascript:alert(1))" }]);
  });
});

describe("plainText", () => {
  it("strips the markup", () => {
    expect(plainText("## Hi **there**\n\n- `x`")).toBe("Hi there x");
  });
});
