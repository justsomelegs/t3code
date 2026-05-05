import { describe, expect, it } from "vitest";

import { normalizeUnifiedDiffToTurnDiffFiles, parseTurnDiffFilesFromUnifiedDiff } from "./Diffs.ts";

describe("parseTurnDiffFilesFromUnifiedDiff", () => {
  it("returns empty list for empty diff", () => {
    expect(parseTurnDiffFilesFromUnifiedDiff("")).toEqual([]);
  });

  it("parses per-file additions and deletions", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+two updated",
      "+three",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -3,2 +3,0 @@",
      "-old",
      "-stale",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 2 },
    ]);
  });

  it("parses rename-only diffs with zero line changes", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "",
    ].join("\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "src/new.ts", additions: 0, deletions: 0 },
    ]);
  });

  it("normalizes CRLF input before parsing", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1,2 @@",
      "-one",
      "+one updated",
      "+two",
      "",
    ].join("\r\n");

    expect(parseTurnDiffFilesFromUnifiedDiff(diff)).toEqual([
      { path: "a.txt", additions: 2, deletions: 1 },
    ]);
  });
});

describe("normalizeUnifiedDiffToTurnDiffFiles", () => {
  it("returns stable per-file patch records", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 1111111..2222222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/created.txt b/created.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/created.txt",
      "@@ -0,0 +1 @@",
      "+created",
      "",
    ].join("\n");

    const files = normalizeUnifiedDiffToTurnDiffFiles(diff);

    expect(files).toMatchObject([
      {
        path: "a.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
      },
      {
        path: "created.txt",
        status: "added",
        additions: 1,
        deletions: 0,
      },
    ]);
    expect(files[0]?.patch).toContain("diff --git a/a.txt b/a.txt");
    expect(files[0]?.patch).not.toContain("created.txt");
    expect(files[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps parser metadata for renames and paths with spaces", () => {
    const diff = [
      'diff --git "a/src/old name.ts" "b/src/new name.ts"',
      "similarity index 86%",
      "rename from src/old name.ts",
      "rename to src/new name.ts",
      "--- a/src/old name.ts",
      "+++ b/src/new name.ts",
      "@@ -1 +1 @@",
      "-export const value = 'old';",
      "+export const value = 'new';",
      "",
    ].join("\n");

    expect(normalizeUnifiedDiffToTurnDiffFiles(diff)).toMatchObject([
      {
        path: "src/new name.ts",
        previousPath: "src/old name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("keeps patch content for unquoted paths with spaces", () => {
    const diff = [
      "diff --git a/foo bar.txt b/foo bar.txt",
      "index 1111111..2222222 100644",
      "--- a/foo bar.txt",
      "+++ b/foo bar.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    expect(normalizeUnifiedDiffToTurnDiffFiles(diff)).toMatchObject([
      {
        path: "foo bar.txt",
        status: "modified",
        patch: expect.stringContaining("diff --git a/foo bar.txt b/foo bar.txt"),
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("keeps patch content for deleted paths with spaces", () => {
    const diff = [
      "diff --git a/old file.txt b/old file.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old file.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "",
    ].join("\n");

    expect(normalizeUnifiedDiffToTurnDiffFiles(diff)).toMatchObject([
      {
        path: "old file.txt",
        status: "deleted",
        patch: expect.stringContaining("deleted file mode 100644"),
        additions: 0,
        deletions: 1,
      },
    ]);
  });

  it("keeps patch content for rename-only paths with spaces", () => {
    const diff = [
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
      "",
    ].join("\n");

    expect(normalizeUnifiedDiffToTurnDiffFiles(diff)).toMatchObject([
      {
        path: "new name.txt",
        previousPath: "old name.txt",
        status: "renamed",
        patch: expect.stringContaining("rename to new name.txt"),
        additions: 0,
        deletions: 0,
      },
    ]);
  });
});
