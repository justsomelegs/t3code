import { CheckpointRef, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLiveDiffCacheKey,
  buildLiveDiffScopeKey,
  getTransientLatestTurnSummary,
  resolveCachedLiveDiffValue,
  sortTurnDiffSummariesForDiffPanel,
} from "./DiffPanel.logic";
import type { TurnDiffSummary } from "../types";

const makeSummary = (
  input: Partial<TurnDiffSummary> & Pick<TurnDiffSummary, "turnId">,
): TurnDiffSummary => ({
  completedAt: "2026-02-27T00:00:00.000Z",
  files: [],
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/thread/turn/1`),
  ...input,
});

describe("DiffPanel logic", () => {
  it("orders turn summaries by descending checkpoint turn count", () => {
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
    });

    const ordered = sortTurnDiffSummariesForDiffPanel([turnOne, unavailable, turnTwo], {});

    expect(ordered.map((summary) => summary.turnId)).toEqual([
      TurnId.make("turn-unavailable"),
      TurnId.make("turn-2"),
      TurnId.make("turn-1"),
    ]);
  });

  it("invalidates cached live diff values when the selected scope changes", () => {
    const turnId = TurnId.make("turn-live");
    const workspaceKey = buildLiveDiffCacheKey({
      turnId,
      scopeKey: buildLiveDiffScopeKey(null),
      ignoreWhitespace: true,
    });
    const fileKey = buildLiveDiffCacheKey({
      turnId,
      scopeKey: buildLiveDiffScopeKey("src/file.ts"),
      ignoreWhitespace: true,
    });

    expect(
      resolveCachedLiveDiffValue({
        selectedCurrentTurn: true,
        selectedTurnId: turnId,
        cacheKey: fileKey,
        cacheEntry: {
          turnId,
          cacheKey: workspaceKey,
          value: "diff --git a/README.md b/README.md",
        },
      }),
    ).toBeNull();
  });

  it("keeps a terminal latest turn visible while checkpoint capture is unavailable", () => {
    const summary = getTransientLatestTurnSummary({
      latestTurn: {
        turnId: TurnId.make("turn-current"),
        state: "completed",
        requestedAt: "2026-02-27T00:00:00.000Z",
        startedAt: "2026-02-27T00:00:01.000Z",
        completedAt: "2026-02-27T00:00:02.000Z",
        assistantMessageId: null,
        checkpointState: "unavailable",
      },
      persistedSummaries: [],
      selectedTurnId: null,
    });

    expect(summary?.turnId).toBe(TurnId.make("turn-current"));
    expect(summary?.checkpointState).toBe("unavailable");
  });

  it("does not create a transient latest turn when the persisted summary already exists", () => {
    const persisted = makeSummary({
      turnId: TurnId.make("turn-existing"),
      checkpointTurnCount: 3,
    });

    expect(
      getTransientLatestTurnSummary({
        latestTurn: {
          turnId: TurnId.make("turn-existing"),
          state: "completed",
          requestedAt: "2026-02-27T00:00:00.000Z",
          startedAt: "2026-02-27T00:00:01.000Z",
          completedAt: "2026-02-27T00:00:02.000Z",
          assistantMessageId: null,
          checkpointState: "ready",
        },
        persistedSummaries: [persisted],
        selectedTurnId: null,
      }),
    ).toBeNull();
  });
});
