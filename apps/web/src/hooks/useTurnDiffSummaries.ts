import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

export function useTurnDiffSummaries(turnDiffSummaries: Thread["turnDiffSummaries"] | undefined) {
  const stableTurnDiffSummaries = useMemo(() => {
    if (!turnDiffSummaries) {
      return [];
    }
    return turnDiffSummaries;
  }, [turnDiffSummaries]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(stableTurnDiffSummaries),
    [stableTurnDiffSummaries],
  );

  return { turnDiffSummaries: stableTurnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
