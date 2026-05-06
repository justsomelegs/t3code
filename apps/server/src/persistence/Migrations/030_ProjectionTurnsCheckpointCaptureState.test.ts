import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("030_ProjectionTurnsCheckpointCaptureState", (it) => {
  it.effect("marks legacy terminal rows without checkpoint state as unavailable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

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
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-no-checkpoint',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-02-27T00:00:00.000Z',
            '2026-02-27T00:00:00.000Z',
            '2026-02-27T00:00:01.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-ready',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-02-27T00:00:02.000Z',
            '2026-02-27T00:00:02.000Z',
            '2026-02-27T00:00:03.000Z',
            1,
            'refs/t3/checkpoints/thread-1/turn/1',
            'ready',
            '[]'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const rows = yield* sql<{
        readonly turnId: string;
        readonly checkpointCaptureState: string;
      }>`
        SELECT
          turn_id AS "turnId",
          checkpoint_capture_state AS "checkpointCaptureState"
        FROM projection_turns
        ORDER BY turn_id ASC
      `;

      assert.deepStrictEqual(rows, [
        {
          turnId: "turn-no-checkpoint",
          checkpointCaptureState: "unavailable",
        },
        {
          turnId: "turn-ready",
          checkpointCaptureState: "ready",
        },
      ]);
    }),
  );
});
