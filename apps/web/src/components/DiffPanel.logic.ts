import type { OrchestrationLatestTurn, TurnId } from "@t3tools/contracts";

import type { TurnDiffSummary } from "../types";

export interface LiveDiffCacheEntry<T> {
  turnId: TurnId;
  cacheKey: string;
  files: T[];
}

export function getFullDiffTurnSummaries(
  summaries: ReadonlyArray<TurnDiffSummary>,
): TurnDiffSummary[] {
  return summaries.filter((summary) => summary.isFullDiffAvailable !== false);
}

export function buildLiveDiffScopeKey(selectedFilePath: string | null): string {
  return selectedFilePath === null ? "workspace" : `file:${selectedFilePath}`;
}

export function buildLiveDiffCacheKey(input: {
  turnId: TurnId;
  scopeKey: string;
  ignoreWhitespace: boolean;
}): string {
  return [
    input.turnId,
    input.scopeKey,
    input.ignoreWhitespace ? "ignore-whitespace" : "show-whitespace",
  ].join("\0");
}

export function resolveCachedLiveDiffFiles<T>(input: {
  selectedCurrentTurn: boolean;
  selectedTurnId: TurnId | null;
  cacheKey: string | null;
  cacheEntry: LiveDiffCacheEntry<T> | null;
}): T[] | null {
  if (
    !input.selectedCurrentTurn ||
    input.selectedTurnId === null ||
    input.cacheKey === null ||
    input.cacheEntry === null
  ) {
    return null;
  }
  return input.cacheEntry.turnId === input.selectedTurnId &&
    input.cacheEntry.cacheKey === input.cacheKey
    ? input.cacheEntry.files
    : null;
}

export function getTransientLatestTurnSummary(input: {
  latestTurn: OrchestrationLatestTurn | null | undefined;
  persistedSummaries: ReadonlyArray<TurnDiffSummary>;
  selectedTurnId: TurnId | null;
}): TurnDiffSummary | null {
  const latestTurn = input.latestTurn;
  if (!latestTurn) {
    return null;
  }
  if (input.persistedSummaries.some((summary) => summary.turnId === latestTurn.turnId)) {
    return null;
  }
  const shouldShow =
    latestTurn.state === "running" ||
    latestTurn.checkpointState === "not-started" ||
    latestTurn.checkpointState === "capturing" ||
    latestTurn.checkpointState === "unavailable" ||
    latestTurn.checkpointState === "error" ||
    input.selectedTurnId === latestTurn.turnId;
  if (!shouldShow) {
    return null;
  }
  return {
    turnId: latestTurn.turnId,
    completedAt: latestTurn.completedAt ?? latestTurn.startedAt ?? latestTurn.requestedAt,
    status: latestTurn.state,
    files: [],
    isFullDiffAvailable: true,
    isRevertable: false,
    checkpointState: latestTurn.checkpointState,
  };
}

export function sortTurnDiffSummariesForDiffPanel(
  summaries: ReadonlyArray<TurnDiffSummary>,
  inferredCheckpointTurnCountByTurnId: Readonly<Record<TurnId, number>>,
): TurnDiffSummary[] {
  return [...summaries].toSorted((left, right) => {
    const leftTurnCount =
      left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
    const rightTurnCount =
      right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
    if (leftTurnCount !== rightTurnCount) {
      return rightTurnCount - leftTurnCount;
    }
    return right.completedAt.localeCompare(left.completedAt);
  });
}
