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
  if (raw === "/dev/null") return "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
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

function parseDiffGitHeader(block: string): { path: string; previousPath?: string } {
  const firstLine = block.split(/\n/, 1)[0] ?? "";
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(firstLine);
  if (!match) {
    return { path: "patch.diff" };
  }

  const previousPath = match[1] ?? "";
  const path = match[2] ?? previousPath;
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

export function normalizeUnifiedDiffToTurnDiffFiles(
  diff: string,
): ReadonlyArray<OrchestrationTurnDiffFile> {
  const blocks = splitUnifiedDiffByFile(diff);
  if (blocks.length === 0) {
    return [];
  }

  const parsedByPath = new Map<string, { additions: number; deletions: number }>();
  try {
    const parsedPatches = parsePatchFiles(diff.replace(/\r\n/g, "\n").trim());
    for (const patch of parsedPatches) {
      for (const file of patch.files) {
        const path = normalizeDiffPath(file.name) || normalizeDiffPath(file.prevName);
        if (!path) continue;
        parsedByPath.set(path, {
          additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
          deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
        });
      }
    }
  } catch {
    // Fall back to line-counting below. Rendering can still show the raw file patch.
  }

  return blocks
    .map((block) => {
      const header = parseDiffGitHeader(block);
      const path = normalizeDiffPath(header.path);
      const previousPath = normalizeDiffPath(header.previousPath);
      const counts = parsedByPath.get(path) ?? countPatchLines(block);
      if (previousPath && previousPath !== path) {
        return {
          path,
          previousPath,
          status: inferStatus(block),
          patch: block,
          additions: counts.additions,
          deletions: counts.deletions,
          hash: hashPatch(block),
        } satisfies OrchestrationTurnDiffFile;
      }
      return {
        path,
        status: inferStatus(block),
        patch: block,
        additions: counts.additions,
        deletions: counts.deletions,
        hash: hashPatch(block),
      } satisfies OrchestrationTurnDiffFile;
    })
    .filter((file) => file.path.length > 0)
    .toSorted((left, right) => left.path.localeCompare(right.path));
}
