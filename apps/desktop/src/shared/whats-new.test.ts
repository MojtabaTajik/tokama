import { describe, expect, it } from "vitest";
import { compareVersions, fixesLine, isVersion, MAX_NOTE_BYTES, type Note, noteKind, parseNote, releaseNotes, SECURITY_LINE } from "./whats-new.js";

const FULL = `---
version: 0.2.0
date: 2026-12-03
security: true
---

## Sounds for notifications

A soft gecko chirp when work needs you.

Where: Pick it in Settings → Notifications

## See what a finished run changed

The Diff tab now shows the exact commit.

+ 12 smaller fixes
`;

/** A note with this body under valid front matter. */
const body = (text: string, front = "version: 0.2.0\ndate: 2026-12-03") => `---\n${front}\n---\n\n${text}\n`;
const problemsOf = (text: string, fileName?: string): readonly string[] => {
  const result = parseNote(text, fileName);
  if (result.ok) throw new Error(`parsed, but problems were expected:\n${JSON.stringify(result.note)}`);
  return result.problems;
};
const noteOf = (text: string): Note => {
  const result = parseNote(text);
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.note;
};
const highlight = (title = "A title", sentence = "One sentence.") => `## ${title}\n\n${sentence}`;

describe("parseNote", () => {
  it("reads a full note", () => {
    expect(noteOf(FULL)).toEqual({
      version: "0.2.0",
      date: "2026-12-03",
      security: true,
      highlights: [
        { title: "Sounds for notifications", text: "A soft gecko chirp when work needs you.", where: "Pick it in Settings → Notifications" },
        { title: "See what a finished run changed", text: "The Diff tab now shows the exact commit." },
      ],
      fixes: 12,
    });
  });

  it("reads a security-only note and a fixes-only note", () => {
    expect(noteOf("---\nversion: 0.2.2\ndate: 2026-12-05\nsecurity: true\n---\n")).toMatchObject({ security: true, highlights: [], fixes: 0 });
    expect(noteOf(body("+ 1 smaller fix"))).toMatchObject({ security: false, highlights: [], fixes: 1 });
    expect(noteOf(body("+ 12 smaller fixes"))).toMatchObject({ fixes: 12 });
  });

  it("reads CRLF like LF", () => {
    expect(parseNote(FULL.replaceAll("\n", "\r\n"))).toEqual(parseNote(FULL));
  });

  it("takes security: false, and the file name when it matches", () => {
    expect(noteOf(body("+ 2 smaller fixes", "version: 1.0.0\ndate: 2027-01-01\nsecurity: false")).security).toBe(false);
    expect(parseNote(FULL, "0.2.0.md").ok).toBe(true);
  });

  describe("limits: exactly at the limit passes, one over fails", () => {
    it("3 highlights pass, 4 fail", () => {
      const three = [1, 2, 3].map((n) => highlight(`Title ${n}`)).join("\n\n");
      expect(noteOf(body(three)).highlights).toHaveLength(3);
      expect(problemsOf(body(`${three}\n\n${highlight("Title 4")}`))).toEqual(["line 18: at most 3 highlights"]);
    });

    it.each([
      ["title", (n: number) => highlight("t".repeat(n)), 60, "line 6: a highlight's title is 61 characters, at most 60"],
      ["sentence", (n: number) => highlight("T", "s".repeat(n)), 200, "line 8: a highlight's sentence is 201 characters, at most 200"],
      ["Where", (n: number) => `${highlight()}\n\nWhere: ${"w".repeat(n)}`, 80, "line 10: a highlight's Where line is 81 characters, at most 80"],
    ])("%s: at most the limit", (_name, make, max, message) => {
      expect(parseNote(body(make(max))).ok).toBe(true);
      expect(problemsOf(body(make(max + 1)))).toEqual([message]);
    });

    it("counts characters, not bytes", () => {
      expect(parseNote(body(highlight("é".repeat(60)))).ok).toBe(true);
    });

    it("fixes: 1 and 999 pass, 0 and 1000 fail", () => {
      expect(noteOf(body("+ 999 smaller fixes")).fixes).toBe(999);
      expect(problemsOf(body("+ 0 smaller fixes"))).toEqual(["line 6: the fix count is 0, from 1 to 999"]);
      expect(problemsOf(body("+ 1000 smaller fixes"))).toEqual(["line 6: the fix count is 1000, from 1 to 999"]);
    });

    it("file: 8 KiB passes, one byte more fails", () => {
      const filler = (bytes: number) => `---\nversion: 0.2.0\ndate: 2026-12-03\n---\n\n${highlight("T", "x")}\n\n+ 1 smaller fix\n${" ".repeat(bytes)}`;
      const base = new TextEncoder().encode(filler(0)).length;
      expect(parseNote(filler(MAX_NOTE_BYTES - base)).ok).toBe(true);
      expect(problemsOf(filler(MAX_NOTE_BYTES - base + 1))).toEqual([`the file is ${MAX_NOTE_BYTES + 1} bytes, at most ${MAX_NOTE_BYTES}`]);
    });
  });

  describe("front matter", () => {
    it("refuses an unknown key, a repeated key and a line that is no key", () => {
      expect(problemsOf(body("+ 1 smaller fix", "version: 0.2.0\ndate: 2026-12-03\nsecurty: true"))).toEqual(['line 4: unknown key "securty"']);
      expect(problemsOf(body("+ 1 smaller fix", "version: 0.2.0\nversion: 0.2.1\ndate: 2026-12-03"))).toEqual(['line 3: "version" appears twice']);
      expect(problemsOf(body("+ 1 smaller fix", "version: 0.2.0\ndate: 2026-12-03\noops"))).toEqual(['line 4: expected "key: value"']);
    });

    it("needs a version and a date", () => {
      expect(problemsOf("---\ndate: 2026-12-03\n---\n+ 1 smaller fix\n")).toEqual(['the front matter has no "version"']);
      expect(problemsOf("---\nversion: 0.2.0\n---\n+ 1 smaller fix\n")).toEqual(['the front matter has no "date"']);
    });

    it("refuses a missing start or end", () => {
      expect(problemsOf("version: 0.2.0\n")).toEqual(['line 1: a note starts with a "---" line and its front matter']);
      expect(problemsOf("---\nversion: 0.2.0\n")).toEqual(['the front matter has no closing "---" line']);
    });

    it.each(["0.2", "01.2.3", "0.2.0.1", "v0.2.0", "1.2.x", "-1.0.0", "1.0.1234567890"])("refuses the version %j", (version) => {
      expect(problemsOf(body("+ 1 smaller fix", `version: ${version}\ndate: 2026-12-03`))).toEqual([`version "${version}" is not x.y.z (digits, no leading zeros)`]);
    });

    it.each(["2026-02-30", "2026-13-01", "2026-1-1", "26-01-01", "yesterday"])("refuses the date %j", (date) => {
      expect(problemsOf(body("+ 1 smaller fix", `version: 0.2.0\ndate: ${date}`))).toEqual([`date "${date}" is not a real YYYY-MM-DD day`]);
    });

    it("accepts a leap day and refuses it in other years", () => {
      expect(parseNote(body("+ 1 smaller fix", "version: 0.2.0\ndate: 2028-02-29")).ok).toBe(true);
      expect(parseNote(body("+ 1 smaller fix", "version: 0.2.0\ndate: 2027-02-29")).ok).toBe(false);
    });

    it("refuses a security value that is not true or false", () => {
      expect(problemsOf(body("+ 1 smaller fix", "version: 0.2.0\ndate: 2026-12-03\nsecurity: yes"))).toEqual(['security "yes" is not true or false']);
    });

    it("refuses a version that differs from the file name", () => {
      expect(problemsOf(FULL, "0.3.0.md")).toEqual(["version 0.2.0 does not match the file name 0.3.0.md"]);
    });
  });

  describe("body", () => {
    it.each([
      ["an HTML block", "<div>hi</div>", 'line 6: expected a "## " title, "Where:" or the fixes line, found "<div>hi</div>"'],
      ["a list", "- one\n- two", 'line 6: expected a "## " title, "Where:" or the fixes line, found "- one"'],
      ["a link", "[site](https://tokama.dev)", 'line 6: expected a "## " title, "Where:" or the fixes line, found "[site](https://tokama.dev)"'],
      ["a # heading", "# Big", 'line 6: only "## " headings are allowed'],
      ["a ### heading", "### Smaller", 'line 6: only "## " headings are allowed'],
      ["a stray paragraph", "Hello.", 'line 6: expected a "## " title, "Where:" or the fixes line, found "Hello."'],
    ])("refuses %s", (_name, text, message) => {
      expect(problemsOf(body(text))).toContain(message);
      expect(problemsOf(body(`${highlight()}\n\n${text}`))).toContain(message.replace("line 6", "line 10"));
    });

    it("refuses < and > in a title, a sentence and a Where line", () => {
      const markup = (line: number, what: string) => `line ${line}: markup characters (< > [ ] \` * @, or a leading # > + - or number) are not allowed in ${what}`;
      expect(problemsOf(body(highlight("<b>x</b>")))).toEqual([markup(6, "a highlight's title")]);
      expect(problemsOf(body(highlight("T", "Press <b>x</b>.")))).toEqual([markup(8, "a highlight's sentence")]);
      expect(problemsOf(body(`${highlight()}\n\nWhere: a > b`))).toEqual([markup(10, "a highlight's Where line")]);
    });

    it.each(["a [link](https://x.test)", "**bold**", "`code`", "ping @someone", "### heading", "- item", "> quote", "1. first"])("refuses Markdown in a sentence: %j", (sentence) => {
      expect(problemsOf(body(highlight("T", sentence)))).toHaveLength(1);
    });

    it("keeps ordinary punctuation", () => {
      expect(parseNote(body(highlight("Faster: 2x, (mostly) fine!", "It's quicker; try it - or not. 3 of 4 work_flows."))).ok).toBe(true);
    });

    it("needs a sentence for each highlight", () => {
      expect(problemsOf(body("## Lonely title"))).toEqual(['line 6: the highlight "Lonely title" has no sentence']);
      expect(problemsOf(body(`## First\n\n${highlight("Second")}`))).toEqual(['line 6: the highlight "First" has no sentence']);
      expect(problemsOf(body("## First\n\nWhere: here"))).toEqual(['line 6: the highlight "First" has no sentence']);
    });

    it("keeps the title and the sentence on their own lines", () => {
      expect(problemsOf(body("## Title\nSentence right after."))).toEqual(["line 6: put a blank line after the title", 'line 6: the highlight "Title" has no sentence']);
      expect(problemsOf(body("## Title\n\nOne.\nTwo."))).toEqual(["line 8: a highlight's sentence is one line"]);
    });

    it("needs the fixes line to be the last block, alone, and written as noted", () => {
      expect(problemsOf(body(`+ 3 smaller fixes\n\n${highlight()}`))).toEqual(["line 6: the fixes line must be the last block"]);
      expect(problemsOf(body("+ 1 smaller fixes"))).toEqual(['line 6: write "+ 1 smaller fix"']);
      expect(problemsOf(body("+ 3 smaller fix"))).toEqual(['line 6: write "+ 3 smaller fixes"']);
      expect(problemsOf(body("+ some fixes"))).toEqual(['line 6: the fixes line reads "+ N smaller fixes"']);
      expect(problemsOf(body("+ 3 smaller fixes\nmore"))).toEqual(["line 6: the fixes line stands alone"]);
    });

    it("refuses an empty note", () => {
      expect(problemsOf("---\nversion: 0.2.0\ndate: 2026-12-03\n---\n")).toEqual(["the note says nothing: add a highlight, security: true or a fix count"]);
      expect(problemsOf("---\nversion: 0.2.0\ndate: 2026-12-03\nsecurity: false\n---\n\n\n")).toEqual(["the note says nothing: add a highlight, security: true or a fix count"]);
    });

    it("refuses a tab or another control character, naming the line", () => {
      expect(problemsOf(body("## T\n\nA\tB."))).toEqual(["line 8: tabs and control characters are not allowed"]);
      expect(problemsOf(body("## T\n\nA\u0007B."))).toEqual(["line 8: tabs and control characters are not allowed"]);
      expect(problemsOf(body("## T\n\nA\rB."))).toEqual(["line 8: tabs and control characters are not allowed"]);
    });

    it("reports every problem it finds, not only the first", () => {
      const problems = problemsOf(body(`## ${"t".repeat(61)}\n\n${"s".repeat(201)}\n\nWhere: ${"w".repeat(81)}`));
      expect(problems).toHaveLength(3);
      expect(problems.every((problem) => /^line \d+: /.test(problem))).toBe(true);
    });
  });

  it("never throws, whatever the text", () => {
    for (const text of ["", "\n", "---", "---\n---", "\u0000", "﻿---\n", "---\n---\n## ", "a".repeat(20_000)]) expect(() => parseNote(text)).not.toThrow();
    expect(parseNote("").ok).toBe(false);
  });
});

describe("compareVersions and isVersion", () => {
  it("compares numerically, part by part", () => {
    expect(compareVersions("0.0.10", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("0.0.9", "0.0.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
  });

  it("knows a version from anything else", () => {
    expect([isVersion("0.2.1"), isVersion("0.2"), isVersion("01.0.0"), isVersion(5), isVersion(undefined)]).toEqual([true, false, false, false, false]);
  });
});

describe("noteKind", () => {
  it("is highlights when there is one, else security, else fixes", () => {
    expect(noteKind(noteOf(FULL))).toBe("highlights");
    expect(noteKind(noteOf("---\nversion: 0.2.2\ndate: 2026-12-05\nsecurity: true\n---\n+ 4 smaller fixes\n"))).toBe("security");
    expect(noteKind(noteOf(body("+ 4 smaller fixes")))).toBe("fixes");
  });
});

describe("fixesLine and releaseNotes", () => {
  it("writes one fix and many fixes", () => {
    expect([fixesLine(1), fixesLine(2), fixesLine(12)]).toEqual(["+ 1 smaller fix", "+ 2 smaller fixes", "+ 12 smaller fixes"]);
  });

  it("writes the release body of a full note without the front matter", () => {
    expect(releaseNotes(noteOf(FULL))).toBe(
      [
        `**Security:** ${SECURITY_LINE}`,
        "### Sounds for notifications\n\nA soft gecko chirp when work needs you.\n\nWhere: Pick it in Settings → Notifications",
        "### See what a finished run changed\n\nThe Diff tab now shows the exact commit.",
        "+ 12 smaller fixes",
      ].join("\n\n"),
    );
  });

  it("writes a fixes-only note and a security-only note", () => {
    expect(releaseNotes(noteOf(body("+ 1 smaller fix")))).toBe("+ 1 smaller fix");
    expect(releaseNotes(noteOf("---\nversion: 0.2.2\ndate: 2026-12-05\nsecurity: true\n---\n"))).toBe(`**Security:** ${SECURITY_LINE}`);
  });

  it("gives back a body that holds no front matter or HTML", () => {
    expect(releaseNotes(noteOf(FULL))).not.toMatch(/---|[<>]/);
  });
});
