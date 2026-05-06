import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = useMemo(
    () => activeThread?.turnDiffSummaries ?? [],
    [activeThread?.turnDiffSummaries],
  );

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
