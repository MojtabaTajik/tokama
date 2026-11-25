// An agent's message as React text with light structure: Markdown headings, lists, fenced code and
// code spans get their own spacing and the mono font, and **bold** and *italics* become strong and
// em elements. Everything else stays as written: links and HTML show as their characters, never as
// elements. One pass over the lines, no regex that can backtrack on a long line.
import type { ReactNode } from "react";
import { visible } from "./DiffView.js";

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: string[] }
  | { readonly kind: "code"; readonly lines: string[] }
  | { readonly kind: "text"; readonly lines: string[] };

/** "## Title" → level 2; undefined for any other line. */
function heading(line: string): { readonly level: number; readonly text: string } | undefined {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level === 0 || level > 6 || (line[level] !== " " && line[level] !== "\t")) return undefined;
  return { level, text: line.slice(level).trim() };
}

/** "- item", "* item", "+ item" or "3. item" (leading spaces allowed); undefined for any other line. */
function listItem(line: string): { readonly ordered: boolean; readonly number: number; readonly text: string } | undefined {
  const rest = line.trimStart();
  if ((rest[0] === "-" || rest[0] === "*" || rest[0] === "+") && rest[1] === " ") return { ordered: false, number: 1, text: rest.slice(2) };
  let digits = 0;
  while (digits < rest.length && digits < 9 && rest[digits]! >= "0" && rest[digits]! <= "9") digits++;
  if (digits > 0 && (rest[digits] === "." || rest[digits] === ")") && rest[digits + 1] === " ") {
    return { ordered: true, number: Number(rest.slice(0, digits)), text: rest.slice(digits + 2) };
  }
  return undefined;
}

export function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  let code: string[] | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trimStart().startsWith("```")) {
      if (code === undefined) blocks.push({ kind: "code", lines: (code = []) });
      else code = undefined;
      continue;
    }
    if (code !== undefined) {
      code.push(line);
      continue;
    }
    const last = blocks.at(-1);
    if (line.trim() === "") {
      // A blank line ends a paragraph or list: the next line starts a new block.
      if (last !== undefined && last.kind !== "code") blocks.push({ kind: "text", lines: [] });
      continue;
    }
    const title = heading(line);
    if (title !== undefined) {
      blocks.push({ kind: "heading", ...title });
      continue;
    }
    const item = listItem(line);
    if (item !== undefined) {
      if (last?.kind === "list" && last.ordered === item.ordered) last.items.push(item.text);
      else blocks.push({ kind: "list", ordered: item.ordered, start: item.number, items: [item.text] });
      continue;
    }
    if (last?.kind === "text") last.lines.push(line);
    else if (last?.kind === "list") last.items[last.items.length - 1] += `\n${line.trim()}`;
    else blocks.push({ kind: "text", lines: [line] });
  }
  return blocks.filter((block) => block.kind !== "text" || block.lines.length > 0);
}

const isSpace = (char: string | undefined) => char === undefined || char.trim() === "";

/**
 * Where the `**` or `*` that closes an emphasis starts, at or after `from`: not right after a space,
 * not inside a code span. -1 when there is none.
 */
function closer(text: string, mark: "**" | "*", from: number): number {
  for (let at = from; at < text.length; at++) {
    if (text[at] === "`") {
      const end = text.indexOf("`", at + 1);
      if (end >= 0) at = end;
    } else if (text[at] === "*") {
      const double = text[at + 1] === "*";
      if (double === (mark === "**") && at > from && !isSpace(text[at - 1])) return at;
      if (double) at++;
    }
  }
  return -1;
}

/** Emphasis inside emphasis goes this deep; deeper marks stay as written. */
const MAX_DEPTH = 2;

/**
 * Text with each pair of backticks as a code span, **bold** as strong and *italics* as em (also
 * inside each other). A mark with no partner stays as written. Each mark that finds no closer is
 * not looked for again, so a long line of loose marks is still read in linear time.
 */
function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const spent = new Set<string>();
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push(plain);
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "`") {
      const end = text.indexOf("`", at + 1);
      if (end >= 0) {
        flush();
        const code = text.slice(at + 1, end);
        out.push(
          code === "" ? (
            "``"
          ) : (
            <code key={out.length} className="st-code">
              {visible(code)}
            </code>
          ),
        );
        at = end + 1;
        continue;
      }
    } else if (char === "*" && depth < MAX_DEPTH) {
      const mark = text.startsWith("**", at) ? "**" : "*";
      // An opening mark is followed by a word and does not sit inside one (2*3*4, x**2).
      const opens = !isSpace(text[at + mark.length]) && text[at + mark.length] !== "*" && !/[\p{L}\p{N}]/u.test(text[at - 1] ?? "");
      const end = opens && !spent.has(mark) ? closer(text, mark, at + mark.length) : -1;
      if (opens && end < 0) spent.add(mark);
      if (end >= 0) {
        flush();
        const inner = inline(text.slice(at + mark.length, end), depth + 1);
        out.push(mark === "**" ? <strong key={out.length}>{inner}</strong> : <em key={out.length}>{inner}</em>);
        at = end + mark.length;
        continue;
      }
      plain += mark;
      at += mark.length;
      continue;
    }
    plain += char;
    at++;
  }
  flush();
  return out;
}

export function StepText({ text }: { readonly text: string }) {
  return (
    <div className="step-text">
      {blocksOf(text).map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <p key={index} className="st-heading" data-level={Math.min(block.level, 3)}>
                {inline(block.text)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, at) => <li key={at}>{inline(item)}</li>);
            return block.ordered ? (
              <ol key={index} className="st-list" start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={index} className="st-list">
                {items}
              </ul>
            );
          }
          case "code":
            return (
              <pre key={index} className="st-pre mono">
                {visible(block.lines.join("\n"))}
              </pre>
            );
          case "text":
            return (
              <p key={index} className="st-para">
                {inline(block.lines.join("\n"))}
              </p>
            );
        }
      })}
    </div>
  );
}
