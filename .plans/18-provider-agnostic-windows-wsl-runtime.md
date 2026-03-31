# Provider-Agnostic Windows/WSL Runtime Plan

## Goal

Add Windows and WSL support in a way that is:

- provider-agnostic
- stable under future provider additions
- extensible to future runtimes like Docker, SSH, or remote Linux
- incremental enough to land as small reviewable PRs

The core rule is that providers must not own Windows/WSL interop logic. They should consume shared runtime, path, and process services.

## Design Principles

1. Detect the host runtime globally.
2. Persist execution environment policy per project and thread.
3. Resolve the effective runtime per action from host runtime plus project policy.
4. Centralize path translation, process launching, and open-in-editor behavior.
5. Keep provider integrations unaware of WSL details whenever possible.

## Core Model

There are three separate concepts:

### 1. Host Runtime

This is where the T3 Code server process is running.

Examples:

- `windows-native`
- `wsl-hosted`
- `linux`
- `macos`

This is detected once from the server environment.

### 2. Execution Environment Policy

This is the persisted policy for where a project or thread should run commands.

Initial values:

- `auto`
- `host`
- `wsl`

Future values can include:

- `docker`
- `ssh`
- `remote`

This must be stored per project, and optionally overridden per thread if the product needs it later.

### 3. Effective Runtime

This is the runtime actually used for a specific action.

It is resolved from:

- host runtime
- execution environment policy
- workspace path shape
- explicit WSL distro selection
- availability checks for required bridge commands or runtimes

This means a single Windows host can support:

- Project A in native Windows
- Project B in WSL
- Project C in `auto`

## Required Shared Services

### RuntimeDetectionService

Responsibilities:

- detect host platform
- detect whether the server is running inside WSL
- detect Windows interop mode
- detect available WSL distros if needed
- detect available bridge commands such as `wsl.exe`, `wslpath`, `wslview`

Outputs a shared runtime description that the rest of the server can consume.

### ExecutionEnvironmentService

Responsibilities:

- read persisted project execution policy
- apply defaults for new projects
- resolve per-thread overrides if introduced
- compute the effective runtime for an action

This is the central place that decides whether a given project runs on host or WSL.

### PathInteropService

Responsibilities:

- validate whether a path matches the target runtime path style
- translate Windows paths to WSL paths when needed
- translate WSL POSIX paths to Windows paths when needed
- preserve line and column suffixes for editor opens

This service must own `wslpath` usage and any equivalent future translation logic.

### CommandExecutionService

Responsibilities:

- resolve command launch plans by runtime
- distinguish native Windows executables from batch launchers
- use shell only when required
- launch WSL commands intentionally rather than through accidental shell behavior
- expose consistent process execution and detached process launching
- own tree-kill semantics on Windows

All infrastructure code that spawns processes should flow through this service.

### OpenTargetService

Responsibilities:

- open URLs in the correct browser path for the effective runtime
- open files in editors with the correct path translation
- open file managers correctly for Windows and WSL

This service should sit on top of `PathInteropService` and `CommandExecutionService`.

## Contract Changes

### Server Runtime Contract

Add a shared contract in `packages/contracts` for the detected host runtime. It should include:

- `platform`
- `pathStyle`
- `isWsl`
- `windowsInteropMode`
- `wslDistroName`

This is returned from `server.getConfig`.

### Project Execution Policy Contract

Add a project-level persisted field for execution policy, initially:

- `auto`
- `host`
- `wsl`

Optionally add:

- `wslDistro`

This is the long-term stable product contract for per-project switching.

### Optional Thread Override Contract

If needed later, threads may override the project policy. This should not be required for the first PRs unless the current architecture makes it nearly free.

## Auto Resolution Rules

On a Windows host, `auto` should behave predictably:

- if the workspace path is a clear Windows path like `C:\...`, prefer `host`
- if the workspace path is clearly WSL-backed or user-chosen WSL, prefer `wsl`
- if the project has a previously persisted explicit choice, keep that choice
- if required tooling only exists in one runtime, surface a clear warning instead of silently changing behavior

The important property is determinism. `auto` should converge to one stable answer, not bounce between Windows and WSL.

## PR Breakdown

## PR 1: Add Host Runtime Contract and Detection

### Scope

- add the shared host runtime schema to `packages/contracts`
- add `detectServerRuntimeEnvironment()` to the server
- return runtime info from `server.getConfig`

### Files

- `packages/contracts/src/server.ts`
- `apps/server/src/runtimeEnvironment.ts`
- `apps/server/src/wsServer.ts`

### Acceptance Criteria

- server config includes runtime environment metadata
- unit tests cover native Windows, Linux, macOS, and WSL-hosted detection
- no user-facing behavior changes yet

## PR 2: Add Execution Environment Policy to Project Metadata

### Scope

- add persisted per-project execution policy
- define default policy for new projects
- expose the policy in orchestration and snapshots

### Files

- `packages/contracts` project/orchestration schemas
- project persistence and projection layers
- project create and update flows

### Acceptance Criteria

- projects persist `auto | host | wsl`
- snapshots expose the selected execution policy
- existing projects get a safe default migration

## PR 3: Introduce CommandExecutionService

### Scope

- create a shared command launch abstraction
- centralize Windows command resolution
- stop relying on ad hoc `shell: process.platform === "win32"` logic

### Files

- `apps/server/src/commandResolution.ts`
- `apps/server/src/processRunner.ts`
- shared tests for launch planning and command resolution

### Acceptance Criteria

- native Windows executables launch without unnecessary shell usage
- `.cmd` and `.bat` launchers still work correctly
- launch behavior is expressed as runtime-aware plans
- tests cover PATHEXT, PATH search, batch vs native, and kill behavior

## PR 4: Add PathInteropService

### Scope

- centralize runtime-specific path validation and translation
- preserve editor line and column suffixes
- support WSL path conversion via `wslpath`

### Files

- new shared server-side path interop module
- unit tests around translation behavior

### Acceptance Criteria

- Windows to WSL and WSL to Windows translations are deterministic
- line and column suffixes survive translation
- invalid path/runtime combinations return explicit errors

## PR 5: Make Open/Editor/Browser Behavior Runtime-Aware

### Scope

- refactor editor open and browser open behavior onto shared services
- support Windows host plus WSL interop paths properly

### Files

- `apps/server/src/open.ts`
- `apps/web` callers that consume server config or open actions

### Acceptance Criteria

- opening a WSL path from a WSL-targeted project works
- file manager behavior works for the effective runtime
- URL open behavior works for host and WSL-hosted cases
- tests cover editor and browser launch resolution

## PR 6: Add Terminal Runtime Validation

### Scope

- validate terminal cwd against the effective runtime
- make shell candidate resolution runtime-aware
- keep the external terminal API mostly unchanged in this PR

### Files

- `apps/server/src/terminal/Layers/Manager.ts`
- terminal tests

### Acceptance Criteria

- Windows runtime rejects raw POSIX cwd with clear errors
- POSIX runtime rejects Windows-style cwd with clear errors
- terminal shell fallback is resolved by runtime, not host-only assumptions

## PR 7: Add Per-Project Terminal Runtime Selection

### Scope

- wire terminal execution to the persisted project execution policy
- add optional WSL distro support
- enable Windows host projects to launch terminals in WSL intentionally

### Files

- terminal request handling
- orchestration state or project metadata readers
- UI controls if minimal exposure is needed immediately

### Acceptance Criteria

- a Windows host can run one project in Windows and another in WSL
- terminal open and restart respect the project execution policy
- `auto` behaves deterministically

## PR 8: Migrate Git, Provider Health Checks, and Provider Startup

### Scope

- move all infrastructure process launching onto shared runtime services
- keep providers largely unaware of WSL specifics

### Files

- `apps/server/src/git/...`
- `apps/server/src/provider/Layers/ProviderHealth.ts`
- provider session startup code such as Codex manager paths

### Acceptance Criteria

- git, provider health checks, and provider startup use the same launcher
- no provider owns its own WSL path conversion logic
- future providers inherit runtime handling by using shared infrastructure

## PR 9: UI Runtime Controls and Visibility

### Scope

- display detected host runtime in the UI where useful
- allow project execution environment selection
- show relevant warnings when runtime and workspace path do not match

### Acceptance Criteria

- users can set project runtime to `auto`, `host`, or `wsl`
- UI reflects server runtime, not just `navigator.platform`
- per-project switching is visible and understandable

## Non-Goals for the First Pass

- Docker runtime support
- SSH runtime support
- provider-specific custom runtime logic
- auto-magical fallback that silently changes project execution target

These should be easier later because the architecture will already separate detection, policy, and execution.

## Testing Strategy

### Unit Tests

Required at each step:

- host runtime detection
- command resolution and launch planning
- path translation
- editor/browser open resolution
- terminal cwd validation
- execution policy resolution

### Integration Tests

Add only where the behavior is truly cross-module:

- per-project host vs WSL resolution on Windows
- open-in-editor for WSL paths
- terminal startup honoring project execution policy

### Key Scenarios

- Windows native host, Windows project
- Windows native host, WSL project
- WSL-hosted server
- Linux host
- `.exe` vs `.cmd` launcher behavior on Windows
- WSL path translation with line and column suffixes
- mixed projects on the same server instance

## Migration Notes

- Existing projects should migrate to `executionEnvironmentPolicy = auto`
- The migration must be stable and non-breaking
- No provider-specific migration should be needed

## Reviewer Notes

To maximize acceptance:

- keep each PR single-purpose
- land contracts and services before user-facing runtime selection
- avoid large provider refactors early
- keep the first few PRs mostly additive
- prefer pure functions and tests over broad behavioral rewrites

## End State

When this plan is complete:

- T3 Code can distinguish host runtime from project execution policy
- one Windows host can support both Windows and WSL projects cleanly
- providers stay mostly runtime-agnostic
- future runtimes like Docker or SSH can plug into the same architecture without revisiting the core design
