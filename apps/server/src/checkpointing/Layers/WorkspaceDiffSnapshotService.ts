import { Deferred, Effect, Layer, Ref } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  WorkspaceDiffSnapshotService,
  type WorkspaceDiffSnapshotInput,
  type WorkspaceDiffSnapshotResult,
  type WorkspaceDiffSnapshotServiceShape,
} from "../Services/WorkspaceDiffSnapshotService.ts";

interface CacheEntry {
  readonly expiresAt: number;
  readonly deferred: Deferred.Deferred<WorkspaceDiffSnapshotResult, CheckpointStoreError>;
}

interface CacheHit {
  readonly deferred: Deferred.Deferred<WorkspaceDiffSnapshotResult, CheckpointStoreError>;
  readonly isOwner: boolean;
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
      const deferred = yield* Deferred.make<WorkspaceDiffSnapshotResult, CheckpointStoreError>();
      const cacheHit = yield* Ref.modify(
        cacheRef,
        (previous): readonly [CacheHit, Map<string, CacheEntry>] => {
          const existing = previous.get(key);
          if (existing && existing.expiresAt > now) {
            return [{ deferred: existing.deferred, isOwner: false }, previous] as const;
          }

          const next = new Map(previous);
          for (const [entryKey, entry] of next) {
            if (entry.expiresAt <= now) {
              next.delete(entryKey);
            }
          }
          next.set(key, { expiresAt: now + CACHE_TTL_MS, deferred });
          return [{ deferred, isOwner: true }, next] as const;
        },
      );

      if (cacheHit.isOwner) {
        const exit = yield* checkpointStore.diffCheckpointToWorkspace(input).pipe(
          Effect.map((result) => ({
            diff: result.diff,
            truncated: result.truncated,
          })),
          Effect.exit,
        );
        yield* Deferred.done(cacheHit.deferred, exit);
      }

      return yield* Deferred.await(cacheHit.deferred);
    });

  return { getLiveTurnDiff } satisfies WorkspaceDiffSnapshotServiceShape;
});

export const WorkspaceDiffSnapshotServiceLive = Layer.effect(WorkspaceDiffSnapshotService, make);
