import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const ServerHostOsFamily = Schema.Literals(["windows", "linux", "macos", "other"]);
export type ServerHostOsFamily = typeof ServerHostOsFamily.Type;

export const ServerPathStyle = Schema.Literals(["windows", "posix"]);
export type ServerPathStyle = typeof ServerPathStyle.Type;

export const ServerHostRuntime = Schema.Struct({
  rawPlatform: TrimmedNonEmptyString,
  osFamily: ServerHostOsFamily,
  pathStyle: ServerPathStyle,
  isWsl: Schema.Boolean,
  wslDistroName: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerHostRuntime = typeof ServerHostRuntime.Type;

export const ServerExecutionEnvironment = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("host"),
  }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type ServerExecutionEnvironment = typeof ServerExecutionEnvironment.Type;

export const ServerExecutionEnvironmentPreference = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("auto"),
  }),
  Schema.Struct({
    kind: Schema.Literal("host"),
  }),
  Schema.Struct({
    kind: Schema.Literal("wsl"),
    distroName: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type ServerExecutionEnvironmentPreference = typeof ServerExecutionEnvironmentPreference.Type;

export const DEFAULT_SERVER_EXECUTION_ENVIRONMENT_PREFERENCE: ServerExecutionEnvironmentPreference =
  { kind: "auto" };
