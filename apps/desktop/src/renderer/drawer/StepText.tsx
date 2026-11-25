// An agent's message as React text with light structure: Markdown headings, lists, fenced code and
// code spans get their own spacing and the mono font. Everything else stays as written: links,
// emphasis and HTML show as their characters, never as elements. One pass over the lines, no
// regex that can backtrack on a long line.
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

/** Text with each pair of backticks shown as a code span; an unpaired backtick stays as written. */
function inline(text: string): ReactNode[] {
  const parts = text.split("`");
  // An even count of parts means one backtick has no partner: it joins the last part again.
  if (parts.length % 2 === 0) parts.push(`\`${parts.pop() ?? ""}`);
  return parts.map((part, index) =>
    index % 2 === 1 && part !== "" ? (
      <code key={index} className="st-code">
        {visible(part)}
      </code>
    ) : index % 2 === 1 ? (
      "``"
    ) : (
      part
    ),
  );
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
