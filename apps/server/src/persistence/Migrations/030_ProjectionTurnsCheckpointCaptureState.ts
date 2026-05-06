import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN checkpoint_capture_state TEXT NOT NULL DEFAULT 'not-started'
  `;

  yield* sql`
    UPDATE projection_turns
    SET checkpoint_capture_state = CASE
      WHEN checkpoint_status = 'ready' THEN 'ready'
      WHEN checkpoint_status = 'error' THEN 'error'
      WHEN checkpoint_status = 'missing' THEN 'unavailable'
      ELSE 'unavailable'
    END
  `;
});
