import { CheckpointRef, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { getFullDiffTurnSummaries, sortTurnDiffSummariesForDiffPanel } from "./DiffPanel.logic";
import type { TurnDiffSummary } from "../types";

const makeSummary = (
  input: Partial<TurnDiffSummary> & Pick<TurnDiffSummary, "turnId">,
): TurnDiffSummary => ({
  completedAt: "2026-02-27T00:00:00.000Z",
  files: [],
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/thread/turn/1`),
  isFullDiffAvailable: true,
  ...input,
});

describe("DiffPanel logic", () => {
  it("excludes unavailable turn summaries from full-diff candidates", () => {
    const unavailable = makeSummary({
      turnId: TurnId.make("turn-unavailable"),
      checkpointRef: CheckpointRef.make("unavailable:event-1"),
      isFullDiffAvailable: false,
    });
    const checkpoint = makeSummary({
      turnId: TurnId.make("turn-checkpoint"),
      checkpointTurnCount: 2,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/turn/2"),
      isFullDiffAvailable: true,
    });

    expect(getFullDiffTurnSummaries([unavailable, checkpoint])).toEqual([checkpoint]);
  });

  it("orders full-diff candidates without using unavailable turn counts", () => {
    const turnOne = makeSummary({
      turnId: TurnId.make("turn-1"),
      checkpointTurnCount: 1,
      completedAt: "2026-02-27T00:00:01.000Z",
    });
    const turnTwo = makeSummary({
      turnId: TurnId.make("turn-2"),
      checkpointTurnCount: 2,
      completedAt: "2026-02-27T00:00:02.000Z",
    });
    const unavailable = makeSummary({
      turnId: TurnId.make("turn-unavailable"),
      checkpointTurnCount: 3,
      checkpointRef: CheckpointRef.make("unavailable:event-unavailable"),
      isFullDiffAvailable: false,
    });

    const fullDiffSummaries = getFullDiffTurnSummaries([turnOne, unavailable, turnTwo]);
    const ordered = sortTurnDiffSummariesForDiffPanel(fullDiffSummaries, {});

    expect(ordered.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-2"),
      TurnId.make("turn-1"),
    ]);
  });
});
