import { createHash } from "node:crypto";

import { parsePatchFiles } from "@pierre/diffs";
import type {
  OrchestrationTurnDiffFile,
  OrchestrationTurnDiffFileStatus,
} from "@t3tools/contracts";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.map((file) => ({
      path: file.name,
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

function normalizeDiffPath(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trimEnd();
  if (trimmed === "/dev/null") return "";
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function splitUnifiedDiffByFile(diff: string): string[] {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const blocks: string[] = [];
  const startPattern = /^diff --git /gm;
  const starts = Array.from(normalized.matchAll(startPattern), (match) => match.index ?? 0);
  if (starts.length === 0) {
    return [normalized];
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? normalized.length;
    blocks.push(normalized.slice(start, end).trim());
  }
  return blocks;
}

function unquoteDiffPath(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

function parsePrefixedPathLine(block: string, prefix: string): string {
  const line = block
    .split("\n")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  return normalizeDiffPath(unquoteDiffPath(line?.trimEnd() ?? ""));
}

function parseRenamePathLine(block: string, prefix: string): string {
  const line = block
    .split("\n")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  return normalizeDiffPath(unquoteDiffPath(line?.trimEnd() ?? ""));
}

function readDiffPathToken(input: string): { token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith('"')) {
    const separator = trimmed.indexOf(" ");
    return separator === -1
      ? { token: trimmed, rest: "" }
      : { token: trimmed.slice(0, separator), rest: trimmed.slice(separator + 1) };
  }

  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { token: trimmed.slice(0, index + 1), rest: trimmed.slice(index + 1) };
    }
  }
  return null;
}

function parseDiffGitHeader(block: string): { path: string; previousPath?: string } {
  const previousMarkerPath =
    parsePrefixedPathLine(block, "--- ") || parseRenamePathLine(block, "rename from ");
  const markerPath =
    parsePrefixedPathLine(block, "+++ ") || parseRenamePathLine(block, "rename to ");
  if (markerPath || previousMarkerPath) {
    const path = markerPath || previousMarkerPath;
    const previousPath = previousMarkerPath || undefined;
    return previousPath && previousPath !== path ? { path, previousPath } : { path };
  }

  const firstLine = block.split(/\n/, 1)[0] ?? "";
  const remainder = firstLine.startsWith("diff --git ")
    ? firstLine.slice("diff --git ".length)
    : "";
  const previousToken = readDiffPathToken(remainder);
  const pathToken = previousToken ? readDiffPathToken(previousToken.rest) : null;
  if (!previousToken || !pathToken) {
    return { path: "patch.diff" };
  }

  const previousPath = normalizeDiffPath(unquoteDiffPath(previousToken.token));
  const path = normalizeDiffPath(unquoteDiffPath(pathToken.token));
  return previousPath === path ? { path } : { path, previousPath };
}

function inferStatus(block: string): OrchestrationTurnDiffFileStatus {
  if (/^new file mode /m.test(block)) return "added";
  if (/^deleted file mode /m.test(block)) return "deleted";
  if (/^rename from /m.test(block) || /^rename to /m.test(block)) return "renamed";
  return "modified";
}

function countPatchLines(block: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of block.split(/\n/g)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function hashPatch(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

function patchBlocksByPath(blocks: ReadonlyArray<string>): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const block of blocks) {
    const header = parseDiffGitHeader(block);
    const path = normalizeDiffPath(header.path);
    const previousPath = normalizeDiffPath(header.previousPath);
    if (path) byPath.set(path, block);
    if (previousPath) byPath.set(previousPath, block);
  }
  return byPath;
}

function fallbackNormalizeDiffBlock(block: string): OrchestrationTurnDiffFile | null {
  const header = parseDiffGitHeader(block);
  const path = normalizeDiffPath(header.path);
  if (!path) {
    return null;
  }

  const previousPath = normalizeDiffPath(header.previousPath);
  const counts = countPatchLines(block);
  const base = {
    path,
    status: inferStatus(block),
    patch: block,
    additions: counts.additions,
    deletions: counts.deletions,
    hash: hashPatch(block),
  } satisfies OrchestrationTurnDiffFile;

  return previousPath && previousPath !== path ? { ...base, previousPath } : base;
}

export function normalizeUnifiedDiffToTurnDiffFiles(
  diff: string,
): ReadonlyArray<OrchestrationTurnDiffFile> {
  const blocks = splitUnifiedDiffByFile(diff);
  if (blocks.length === 0) {
    return [];
  }

  try {
    const parsedPatches = parsePatchFiles(diff.replace(/\r\n/g, "\n").trim());
    const patchByPath = patchBlocksByPath(blocks);
    const files = parsedPatches.flatMap((patch) =>
      patch.files.flatMap((file) => {
        const path = normalizeDiffPath(file.name) || normalizeDiffPath(file.prevName);
        if (!path) return [];

        const previousPath = normalizeDiffPath(file.prevName);
        const block = patchByPath.get(path) ?? patchByPath.get(previousPath) ?? "";
        const base = {
          path,
          status: block ? inferStatus(block) : previousPath ? "renamed" : "modified",
          patch: block,
          additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
          deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
          hash: hashPatch(block),
        } satisfies OrchestrationTurnDiffFile;

        return previousPath && previousPath !== path ? [{ ...base, previousPath }] : [base];
      }),
    );

    if (files.length > 0) {
      return files.toSorted((left, right) => left.path.localeCompare(right.path));
    }
  } catch {
    // Fall back to line-counting below. Rendering can still show the raw file patch.
  }

  return blocks
    .flatMap((block) => {
      const file = fallbackNormalizeDiffBlock(block);
      return file ? [file] : [];
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));
}
