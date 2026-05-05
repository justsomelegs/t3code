import { Effect, Layer, Ref } from "effect";

import { normalizeUnifiedDiffToTurnDiffFiles } from "../Diffs.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  WorkspaceDiffSnapshotService,
  type WorkspaceDiffSnapshotInput,
  type WorkspaceDiffSnapshotResult,
  type WorkspaceDiffSnapshotServiceShape,
} from "../Services/WorkspaceDiffSnapshotService.ts";

interface CacheEntry {
  readonly expiresAt: number;
  readonly promise: Promise<WorkspaceDiffSnapshotResult>;
}

const CACHE_TTL_MS = 750;

function stableScopeKey(scope: WorkspaceDiffSnapshotInput["scope"]) {
  return JSON.stringify(scope);
}

const make = Effect.gen(function* () {
  const checkpointStore = yield* CheckpointStore;
  const cacheRef = yield* Ref.make(new Map<string, CacheEntry>());

  const getLiveTurnDiff: WorkspaceDiffSnapshotServiceShape["getLiveTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const key = [
        input.cwd,
        input.fromCheckpointRef,
        input.ignoreWhitespace ? "ignore-ws" : "normal-ws",
        stableScopeKey(input.scope),
      ].join("\0");
      const now = Date.now();
      const promise = yield* Ref.modify(cacheRef, (previous) => {
        const existing = previous.get(key);
        if (existing && existing.expiresAt > now) {
          return [existing.promise, previous] as const;
        }

        const promise = Effect.runPromise(
          checkpointStore.diffCheckpointToWorkspace(input).pipe(
            Effect.map((result) => ({
              files: normalizeUnifiedDiffToTurnDiffFiles(result.diff),
              truncated: result.truncated,
            })),
          ),
        );

        const next = new Map(previous);
        for (const [entryKey, entry] of next) {
          if (entry.expiresAt <= now) {
            next.delete(entryKey);
          }
        }
        next.set(key, { expiresAt: now + CACHE_TTL_MS, promise });
        return [promise, next] as const;
      });
      return yield* Effect.promise(() => promise);
    });

  return { getLiveTurnDiff } satisfies WorkspaceDiffSnapshotServiceShape;
});

export const WorkspaceDiffSnapshotServiceLive = Layer.effect(WorkspaceDiffSnapshotService, make);
