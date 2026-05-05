import type { TurnId } from "@t3tools/contracts";

import type { TurnDiffSummary } from "../types";

export function getFullDiffTurnSummaries(
  summaries: ReadonlyArray<TurnDiffSummary>,
): TurnDiffSummary[] {
  return summaries.filter((summary) => summary.isFullDiffAvailable !== false);
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
