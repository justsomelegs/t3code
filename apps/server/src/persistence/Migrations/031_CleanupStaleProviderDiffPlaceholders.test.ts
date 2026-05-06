import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("031_CleanupStaleProviderDiffPlaceholders", (it) => {
  it.effect("clears only stale provider-diff checkpoint fields from projected turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_capture_state,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-stale',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-02-27T00:00:00.000Z',
            '2026-02-27T00:00:00.000Z',
            '2026-02-27T00:00:01.000Z',
            1,
            'provider-diff:event-stale',
            'missing',
            'unavailable',
            '[]'
          ),
          (
            'thread-1',
            'turn-real',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-02-27T00:00:02.000Z',
            '2026-02-27T00:00:02.000Z',
            '2026-02-27T00:00:03.000Z',
            2,
            'refs/t3/checkpoints/thread-1/turn/2',
            'ready',
            'ready',
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 31 });

      const rows = yield* sql<{
        readonly turnId: string;
        readonly checkpointTurnCount: number | null;
        readonly checkpointRef: string | null;
        readonly checkpointStatus: string | null;
        readonly checkpointCaptureState: string;
      }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_capture_state AS "checkpointCaptureState"
        FROM projection_turns
        ORDER BY turn_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          turnId: "turn-real",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          checkpointStatus: "ready",
          checkpointCaptureState: "ready",
        },
        {
          turnId: "turn-stale",
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointCaptureState: "unavailable",
        },
      ]);
    }),
  );
});
