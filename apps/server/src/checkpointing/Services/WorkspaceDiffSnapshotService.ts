import type {
  CheckpointRef,
  OrchestrationTurnDiffScope,
  OrchestrationTurnDiffFile,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";

export interface WorkspaceDiffSnapshotInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly ignoreWhitespace: boolean;
  readonly scope: OrchestrationTurnDiffScope;
}

export interface WorkspaceDiffSnapshotResult {
  readonly files: ReadonlyArray<OrchestrationTurnDiffFile>;
  readonly truncated: boolean;
}

export interface WorkspaceDiffSnapshotServiceShape {
  readonly getLiveTurnDiff: (
    input: WorkspaceDiffSnapshotInput,
  ) => Effect.Effect<WorkspaceDiffSnapshotResult, CheckpointStoreError>;
}

export class WorkspaceDiffSnapshotService extends Context.Service<
  WorkspaceDiffSnapshotService,
  WorkspaceDiffSnapshotServiceShape
>()("t3/checkpointing/Services/WorkspaceDiffSnapshotService") {}
