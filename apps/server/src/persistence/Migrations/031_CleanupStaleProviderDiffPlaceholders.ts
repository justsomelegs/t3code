import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_turns
    SET
      checkpoint_turn_count = NULL,
      checkpoint_ref = NULL,
      checkpoint_status = NULL,
      checkpoint_capture_state = 'unavailable',
      checkpoint_files_json = '[]'
    WHERE checkpoint_ref LIKE 'provider-diff:%'
  `;
});
