# Branchestra Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build production-shaped, fail-closed Claude and Codex Provider Adapters that use only verified external subscription-authenticated CLIs, supply deterministic shared context and read-only tools, survive interruption, and complete a real two-Agent Branchestra task slice.

**Architecture:** Keep the Milestone 2 task engine dependent only on `TaskProviderPort`; `ProviderAdapter` extends that port with discovery, health, capability, auth, and pure event-normalization contracts. The utility-process worker owns SQLite and launches one detached Node provider-runner process group per run; only that child imports an SDK, while the worker durably records raw events before normalization, supervises cancellation, and resumes sessions from stored IDs and context bundles.

**Tech Stack:** Electron, React, TypeScript, Zod, SQLite `DatabaseSync`, Node `child_process`, Vitest, Playwright, `@anthropic-ai/claude-agent-sdk` `0.3.216`, `@openai/codex-sdk` `0.144.6`

## Global Constraints

- Milestone 1 secure shell/storage/timeline and Milestone 2 task/Git/mock-provider engine are complete before this plan starts.
- Pin `@anthropic-ai/claude-agent-sdk` to exactly `0.3.216`; do not use a range.
- Pin `@openai/codex-sdk` to exactly `0.144.6`; do not use a range.
- Subscription-only mode has no API-key, `baseUrl`, custom-provider, Bedrock, Vertex, Foundry, or hidden billing fallback.
- Every provider process uses the onboarding-verified canonical absolute external CLI path; no PATH lookup, SDK default binary, bundled executable, or CLI JSONL fallback is permitted in this milestone.
- Provider child environments are built from adapter-specific allowlists and never spread `process.env`.
- Unknown executable version, event semantics, auth output, auth mode, sandbox enforcement, process identity, or recovery state fails closed.
- Claude public subscription support remains compile-time disabled until a repository code review records Anthropic's written approval and applicable scope; only test-injected policy and private development verification may enable it.
- Public artifacts must not redistribute Claude or Codex executables, including SDK optional platform binaries. This plan creates external-path-only factories and source-level import guards; the release milestone owns packager exclusions and DMG/ASAR artifact scanning.
- Renderer code receives health metadata only. Tokens, auth files, raw auth probe output, and unredacted provider stderr never enter Renderer IPC, SQLite, timeline events, or logs.
- Codex is constructed with `codexPathOverride`, an explicit replacement `env`, and exactly one Branchestra-owned SDK `config` override: `debug.config_lockfile.load_path` plus `allow_codex_version_mismatch: false`. The reviewed, version-matched effective-config lock is authoritative over user and project config and fixes the built-in `openai` provider and official ChatGPT endpoint. Branchestra never supplies SDK `apiKey`, `baseUrl`, an arbitrary provider config, or an unlocked model-provider override.
- Codex threads always use the task worktree, `sandboxMode: "workspace-write"`, `approvalPolicy: "never"`, and `webSearchMode: "disabled"`; `networkAccessEnabled` is exactly the durable task receipt's `toolNetwork` boolean and defaults to `false`.
- Claude queries always use `pathToClaudeCodeExecutable`, `permissionMode: "default"`, `canUseTool`, explicit disallowed tools and sandbox settings, `strictMcpConfig: true`, and `settingSources: []`.
- Cancellation first aborts the SDK (`AbortController`, plus Claude `query.close()`), then sends TERM and KILL to a re-verified process group within typed deadlines.
- Core process execution is argv-only through the existing secure command runner; no shell command strings are introduced.
- Agent writes remain inside the Agent's approved worktree, Git mutations remain exclusively in Git Manager, and internal context/Git tools are read-only.
- CI uses sanitized fixtures and fake SDK factories. Real-provider smoke tests require a manually invoked private-development target on an already logged-in Mac and never run in public CI.

---

## Prerequisite Interfaces Kept Stable

Milestone 3 extends these already-shipped seams instead of creating parallel owners:

```ts
// src/worker/tasks/provider-port.ts from Milestone 2
export interface TaskProviderPort {
  startRun(request: TaskProviderRunRequest): Promise<TaskProviderRunHandle>;
  resumeRun(request: TaskProviderResumeRequest): Promise<TaskProviderRunHandle>;
  cancelRun(runId: string, reason: "user" | "quit" | "timeout"): Promise<void>;
}

export interface TaskProviderRunHandle {
  runId: string;
  sessionId: string | null;
  events: AsyncIterable<TaskProviderEvent>;
  completion: Promise<TaskProviderRunResult>;
}

// src/worker/storage/database.ts and command-handler.ts from Milestone 1
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(work: () => T): T;
  close(): void;
}

export interface CommandHandler<TType extends WorkerCommand["type"]> {
  readonly type: TType;
  handle(
    command: Extract<WorkerCommand, { type: TType }>,
    ctx: CommandContext,
  ): Promise<HandlerResult> | HandlerResult;
}
```

The existing `openDatabase`, `runMigrations`, `createRepositories`, `idempotency_records`, `EventStore.append/snapshot/after`, `createWorkerRouter`, versioned protocol envelopes, `BranchestraApi`, `createTimelineStore`, `GitManager`, task state machine, approval receipts, worktree manager, checkpoint manager, and integration-candidate flow remain the only owners of their respective concerns.

## File Map

### Shared contracts and policy

- `src/shared/contracts/provider.ts`: Provider IDs, capabilities, health/auth states, normalized events, context bundle types, and runner payload schemas.
- `src/worker/providers/provider-adapter.ts`: Worker-layer `ProviderAdapter extends TaskProviderPort`; shared contracts never import worker modules.
- `src/shared/contracts/provider-runner.ts`: Size-bounded worker↔provider-runner JSONL envelopes.
- `src/shared/config/provider-release-policy.ts`: Public compile-time provider policy with Claude subscription support literally disabled.
- `src/worker/tasks/provider-port.ts`: Re-export the shared run contracts while keeping the Milestone 2 task-engine port stable.

### Worker-owned provider services

- `src/worker/providers/support-matrix.ts`: Exact `(SDK, CLI, architecture)` compatibility records.
- `src/worker/providers/executable-discovery.ts`: Common-location discovery, executable checks, realpath canonicalization, and version probing.
- `src/worker/providers/provider-environment.ts`: Claude/Codex-specific clean child environments.
- `src/worker/providers/auth-probes.ts`: Same-executable auth-mode probes and fail-closed parsers.
- `src/shared/security/codex-config-lock.ts`: Node-only hash/canonical-path/version validation shared by the worker and Provider runner for the reviewed authoritative Codex effective-config lock; Renderer import rules reject this module.
- `resources/codex/0.144.6/subscription.config.lock.toml`: Credential-free lock generated by the exact supported Codex CLI from a clean configuration layer and reviewed as source.
- `config/codex-config-lock-manifest.json`: Strict version, repository/resource path, size, and SHA-256 metadata consumed by runtime and release verifiers.
- `src/worker/providers/provider-health-service.ts`: Persisted installation selection and sanitized onboarding health.
- `src/worker/providers/provider-registry.ts`: Production/test adapter registration and policy gate.
- `src/worker/providers/provider-run-coordinator.ts`: Detached runner lifecycle, raw-event-first persistence, normalization, and task-port handles.
- `src/worker/providers/provider-session-service.ts`: Session/thread persistence, resume, and recovery fallback.
- `src/worker/providers/normalization/claude-event.ts`: Pure `unknown` Claude event parser/normalizer; no SDK import.
- `src/worker/providers/normalization/codex-event.ts`: Pure `unknown` Codex event parser/normalizer; no SDK import.

### Context and tools

- `src/worker/context/context-builder.ts`: Recent verbatim, room memory, decisions, relevant older history, peer artifacts, canonical serialization, and SHA-256 hash.
- `src/worker/context/context-repository.ts`: Context bundle persistence and bounded history queries.
- `src/worker/tools/read-only-tool-service.ts`: `context.search/read` and `git.status/diff/show/log` dispatch.
- `src/worker/tools/tool-bridge.ts`: Correlates runner tool requests with worker-owned read-only services.

### Dedicated provider-runner child

- `src/provider-runner/index.ts`: JSONL loop and provider-specific lazy import.
- `src/provider-runner/jsonl-channel.ts`: Bounded line framing and schema validation.
- `src/provider-runner/runtime.ts`: Provider runtime interface and abort/close lifecycle.
- `src/provider-runner/claude-runtime.ts`: Claude Agent SDK query, permissions, sandbox, MCP tools, resume, and cancellation.
- `src/provider-runner/codex-runtime.ts`: Codex SDK client/thread, item streaming, resume, permission-failure termination, and cancellation.
- `src/provider-runner/sdk-factories.ts`: Required-path, test-injectable SDK factories; the only SDK imports in application source.

### Process supervision and persistence

- `src/worker/process/provider-process-supervisor.ts`: `detached: true` spawn, process-group signals, deadlines, and cleanup.
- `src/worker/process/process-identity.ts`: Node runner and external CLI realpaths, process start token, argv run ID, and group verification.
- `src/worker/storage/migrations.ts`: Register logical migration `003_provider_runtime` after Milestone 2 schema version 2, creating Provider tables and extending the existing operation journal.
- `src/worker/storage/provider-repository.ts`: Provider installation/run/session/event/context persistence.
- Existing `src/worker/operations/operation-journal.ts`: Extend Milestone 2's single external-side-effect journal with provider-process identity and signal observations; do not create a second journal.

### Renderer and protocol integration

- `src/renderer/features/onboarding/ProviderHealthStep.tsx`: Disclosure, CLI selection, version/auth/capability health, repair guidance, and public Claude policy state.
- `src/renderer/features/onboarding/ProviderHealthCard.tsx`: One sanitized Provider health card.
- Existing shared protocol, Main request handler, worker router, timeline store, and `App.tsx`: narrow health/pick/refresh commands and timeline events.

### Tests and fixtures

- `tests/fixtures/providers/claude/*.jsonl` and `tests/fixtures/providers/codex/*.jsonl`: Sanitized recorded-shape events, unknown-field variants, partial streams, permission failures, and malformed semantic cases.
- `tests/fixtures/process/*.mjs`: Runner/grandchild lifecycle fixtures with no provider dependency.
- `tests/unit/providers`, `tests/unit/context`, `tests/unit/tools`, `tests/unit/process`: Pure contract, policy, normalization, environment, hashing, tool, and supervisor tests.
- `tests/integration/providers`: SQLite, runner protocol, persistence/recovery, and real-adapter/fake-SDK tests.
- `e2e/provider-onboarding.spec.ts` and `e2e/dual-agent-provider-task.spec.ts`: UI and full task slice.
- `tests/private/providers/real-provider-smoke.test.ts`: Explicitly invoked private verification using external logged-in CLIs.

### Task 1: Pin SDKs and Establish the Shared Provider Contract

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/worker/tasks/provider-port.ts`
- Create: `src/shared/contracts/provider.ts`
- Create: `src/worker/providers/provider-adapter.ts`
- Create: `src/shared/config/provider-release-policy.ts`
- Create: `tests/unit/providers/provider-contract.test.ts`
- Create: `tests/unit/providers/sdk-version-policy.test.ts`

**Interfaces:**
- Consumes: Milestone 2 `TaskProviderPort`, `TaskProviderRunHandle`, `TaskProviderRunRequest`, `TaskProviderResumeRequest`, `TaskProviderEvent`, and `TaskProviderRunResult`.
- Produces: shared `ProviderId`, `ProviderCapabilities`, `ProviderHealth`, `ProviderEvent`, `ContextBundle`, `ApprovedRunCapabilities`, `ProviderRunPayloadSchema`; worker-layer `ProviderAdapter extends TaskProviderPort`; `PUBLIC_PROVIDER_RELEASE_POLICY` is the only production policy value.

- [ ] **Step 1: Write failing contract and version-policy tests**

```ts
// tests/unit/providers/provider-contract.test.ts
import { describe, expect, it } from "vitest";
import {
  ProviderCapabilitiesSchema,
  ProviderEventSchema,
} from "../../../src/shared/contracts/provider";
import { PUBLIC_PROVIDER_RELEASE_POLICY } from "../../../src/shared/config/provider-release-policy";

describe("provider contract", () => {
  it("requires independently reported capabilities", () => {
    expect(() => ProviderCapabilitiesSchema.parse({ processAbort: true })).toThrow();
    expect(ProviderCapabilitiesSchema.parse({
      interactiveApproval: false,
      protocolInterrupt: false,
      processAbort: true,
      textDeltaStreaming: false,
      itemEventStreaming: true,
      sessionResume: true,
      workspaceWriteSandbox: true,
      toolNetworkControl: true,
      contextTools: "injected",
    })).toBeTruthy();
  });

  it("rejects normalized events without critical semantics", () => {
    expect(() => ProviderEventSchema.parse({ type: "session.started" })).toThrow();
  });

  it("keeps Claude subscription support disabled in public builds", () => {
    expect(PUBLIC_PROVIDER_RELEASE_POLICY.claudeSubscription).toEqual({
      enabled: false,
      writtenApproval: null,
    });
  });
});
```

```ts
// tests/unit/providers/sdk-version-policy.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("provider SDK version policy", () => {
  it("uses exact reviewed SDK versions", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe("0.3.216");
    expect(pkg.dependencies["@openai/codex-sdk"]).toBe("0.144.6");
  });

  it("does not import SDK platform executables from application source", () => {
    const forbidden = [
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
      "@openai/codex/bin",
    ];
    const source = readFileSync("src/provider-runner/sdk-factories.ts", "utf8");
    for (const moduleName of forbidden) expect(source).not.toContain(moduleName);
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing contract and version pins fail**

Run: `pnpm exec vitest run tests/unit/providers/provider-contract.test.ts tests/unit/providers/sdk-version-policy.test.ts`

Expected: FAIL with `Cannot find module '../../../src/shared/contracts/provider'` or an assertion showing the two dependency versions are absent.

- [ ] **Step 3: Add exact SDK dependencies**

Run: `pnpm add --save-exact @anthropic-ai/claude-agent-sdk@0.3.216 @openai/codex-sdk@0.144.6`

Expected: exit 0; `package.json` and `pnpm-lock.yaml` record exactly `0.3.216` and `0.144.6`.

- [ ] **Step 4: Add the minimal shared contract and literal public policy**

```ts
// src/shared/contracts/provider.ts
import { z } from "zod";

export const ProviderIdSchema = z.enum(["claude", "codex"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderCapabilitiesSchema = z.object({
  interactiveApproval: z.boolean(),
  protocolInterrupt: z.boolean(),
  processAbort: z.boolean(),
  textDeltaStreaming: z.boolean(),
  itemEventStreaming: z.boolean(),
  sessionResume: z.boolean(),
  workspaceWriteSandbox: z.boolean(),
  toolNetworkControl: z.boolean(),
  contextTools: z.enum(["mcp", "injected"]),
}).strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

const ProviderEventBaseSchema = z.object({
  runId: z.string().uuid(),
  provider: ProviderIdSchema,
  providerSeq: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});

export const ProviderEventSchema = z.discriminatedUnion("type", [
  ProviderEventBaseSchema.extend({
    type: z.literal("session.started"),
    sessionId: z.string().min(1),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("assistant.delta"),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("assistant.completed"),
    messageId: z.string().min(1),
    text: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("item.snapshot"),
    itemId: z.string().min(1),
    itemType: z.string().min(1),
    status: z.enum(["started", "updated", "completed"]),
    summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("tool.started"),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("tool.completed"),
    toolCallId: z.string().min(1),
    isError: z.boolean(),
    summary: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("approval.required"),
    capability: z.string().min(1),
    reason: z.string().min(1),
    resumeStrategy: z.literal("next_run"),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("run.completed"),
    result: z.string(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("run.failed"),
    code: z.enum([
      "aborted",
      "auth_unavailable",
      "incompatible",
      "permission_denied",
      "provider_error",
      "protocol_error",
    ]),
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

export const ApprovedRunCapabilitiesSchema = z.object({
  workspaceRootRealpath: z.string().startsWith("/"),
  readableRootsRealpath: z.array(z.string().startsWith("/")),
  commandClasses: z.array(z.enum(["build", "test", "lint", "format"])),
  toolNetwork: z.boolean(),
  allowCollaborator: z.boolean(),
  maxRunMs: z.number().int().positive(),
}).strict();
export type ApprovedRunCapabilities = z.infer<typeof ApprovedRunCapabilitiesSchema>;

export const ProviderRunPayloadSchema = z.object({
  taskId: z.string().min(1),
  roomId: z.string().min(1),
  role: z.enum(["lead", "collaborator"]),
  instruction: z.string().min(1),
  worktreePath: z.string().startsWith("/"),
  contextVersion: z.number().int().positive(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  approvedCapabilities: ApprovedRunCapabilitiesSchema,
  deniedWriteRoots: z.array(z.string().startsWith("/")),
  environment: z.record(z.string(), z.string()),
}).strict();
export type ProviderRunPayload = z.infer<typeof ProviderRunPayloadSchema>;

export interface ContextBundle {
  version: number;
  hash: string;
  roomId: string;
  taskId: string;
  role: "lead" | "collaborator";
  payload: ContextBundlePayload;
}

export interface ContextBundlePayload {
  task: { instruction: string; approvedScope: string; lead: ProviderId };
  recentVerbatim: readonly ContextMessage[];
  roomMemory: { summaryVersion: number; summary: string; decisions: readonly string[] };
  relevantHistory: readonly ContextMessage[];
  peer: {
    messages: readonly ContextMessage[];
    checkpointOid: string | null;
    diffSummary: string | null;
    tests: readonly string[];
    toolSummaries: readonly string[];
  };
  injectedReadOnlySnapshot: string | null;
}

export interface ContextMessage {
  eventId: string;
  roomSeq: number;
  author: "user" | ProviderId;
  body: string;
}

export interface ProviderHealth {
  provider: ProviderId;
  state: "missing" | "incompatible" | "unauthenticated" | "policy_disabled" | "ready";
  executableRealpath: string | null;
  cliVersion: string | null;
  sdkVersion: string;
  architecture: "arm64" | "x64";
  authLabel: "Subscription-only";
  capabilities: ProviderCapabilities | null;
  repairAction: string | null;
}

```

```ts
// src/worker/providers/provider-adapter.ts
import type {
  ProviderCapabilities,
  ProviderEvent,
  ProviderHealth,
  ProviderId,
} from "../../shared/contracts/provider";
import type { TaskProviderPort } from "../tasks/provider-port";

export interface ProviderAdapter extends TaskProviderPort {
  readonly provider: ProviderId;
  detect(): Promise<ProviderHealth>;
  probeCapabilities(executableRealpath: string): Promise<ProviderCapabilities>;
  getAuthStatus(executableRealpath: string): Promise<ProviderHealth["state"]>;
  normalizeEvent(
    raw: unknown,
    run: { runId: string; providerSeq: number; occurredAt: string },
  ): ProviderEvent[];
}
```

```ts
// src/shared/config/provider-release-policy.ts
export const PUBLIC_PROVIDER_RELEASE_POLICY = {
  claudeSubscription: {
    enabled: false,
    writtenApproval: null,
  },
  codexSubscription: {
    enabled: true,
  },
} as const;
```

Keep the Milestone 2 `ApprovedRunCapabilities` field names and nullable `sessionId` exactly as quoted above. Change `src/worker/tasks/provider-port.ts` only so its request additionally includes the validated `executableRealpath`, its resume request retains `providerSessionId` and `recoveryBrief`, and its event type aliases `ProviderEvent`. Do not change the three `TaskProviderPort` method signatures or the run-handle shape.

- [ ] **Step 5: Run contract, version, and type tests**

Run: `pnpm exec vitest run tests/unit/providers/provider-contract.test.ts tests/unit/providers/sdk-version-policy.test.ts && pnpm typecheck`

Expected: exit 0; both test files PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/shared/contracts/provider.ts src/shared/config/provider-release-policy.ts src/worker/providers/provider-adapter.ts src/worker/tasks/provider-port.ts tests/unit/providers/provider-contract.test.ts tests/unit/providers/sdk-version-policy.test.ts
git commit -m "feat: define provider adapter contracts"
```

### Task 2: Discover Only Canonical External Executables and Enforce the Support Matrix

**Files:**
- Modify: `src/worker/process/exec-file.ts`
- Create: `src/worker/providers/support-matrix.ts`
- Create: `src/worker/providers/executable-discovery.ts`
- Create: `tests/unit/providers/executable-discovery.test.ts`
- Create: `tests/unit/providers/support-matrix.test.ts`

**Interfaces:**
- Consumes: `ProviderId`; Milestone 1 argv-only `ExecFileRunner = (executable, args, options) => Promise<ExecFileResult>`.
- Produces: `discoverExternalExecutable(input): Promise<DetectedExecutable | null>`, `parseProviderCliVersion(provider, stdout): string`, and `evaluateSupport(input): SupportDecision`.

- [ ] **Step 1: Write failing canonical-path and compatibility tests**

```ts
// tests/unit/providers/executable-discovery.test.ts
import { access, chmod, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { discoverExternalExecutable } from "../../../src/worker/providers/executable-discovery";

describe("external provider executable discovery", () => {
  it("returns the realpath and probes that exact executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-cli-"));
    const executable = join(root, "claude-real");
    const selected = join(root, "claude");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    await symlink(executable, selected);
    const runner = vi.fn().mockResolvedValue({ stdout: "2.1.206\n", stderr: "" });

    const detected = await discoverExternalExecutable({
      provider: "claude",
      selectedPath: selected,
      homeDirectory: root,
      architecture: "arm64",
      runner,
    });

    expect(detected?.executableRealpath).toBe(await realpath(executable));
    expect(runner).toHaveBeenCalledWith(
      await realpath(executable),
      ["--version"],
      expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }),
    );
    await access(detected!.executableRealpath);
  });

  it("does not consult PATH or accept a non-executable file", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-cli-"));
    const selected = join(root, "codex");
    await writeFile(selected, "not executable", "utf8");
    const runner = vi.fn();
    const detected = await discoverExternalExecutable({
      provider: "codex",
      selectedPath: selected,
      homeDirectory: root,
      architecture: "x64",
      runner,
    });
    expect(detected).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });
});
```

```ts
// tests/unit/providers/support-matrix.test.ts
import { describe, expect, it } from "vitest";
import { evaluateSupport } from "../../../src/worker/providers/support-matrix";

describe("provider support matrix", () => {
  it.each([
    ["claude", "0.3.216", "2.1.206", "arm64"],
    ["claude", "0.3.216", "2.1.206", "x64"],
    ["codex", "0.144.6", "0.144.6", "arm64"],
    ["codex", "0.144.6", "0.144.6", "x64"],
  ] as const)("accepts the reviewed %s tuple", (provider, sdkVersion, cliVersion, architecture) => {
    expect(evaluateSupport({ provider, sdkVersion, cliVersion, architecture })).toEqual({ supported: true });
  });

  it("fails closed on an unreviewed CLI patch", () => {
    expect(evaluateSupport({
      provider: "codex",
      sdkVersion: "0.144.6",
      cliVersion: "0.144.7",
      architecture: "arm64",
    })).toEqual({ supported: false, reason: "Unsupported Codex CLI 0.144.7 for SDK 0.144.6 on arm64" });
  });
});
```

- [ ] **Step 2: Run the tests and verify discovery modules are absent**

Run: `pnpm exec vitest run tests/unit/providers/executable-discovery.test.ts tests/unit/providers/support-matrix.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/providers/executable-discovery'`.

- [ ] **Step 3: Implement exact support records and canonical discovery**

```ts
// src/worker/providers/support-matrix.ts
import type { ProviderId } from "../../shared/contracts/provider";

export interface SupportTuple {
  provider: ProviderId;
  sdkVersion: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
}

const SUPPORTED = new Set([
  "claude:0.3.216:2.1.206:arm64",
  "claude:0.3.216:2.1.206:x64",
  "codex:0.144.6:0.144.6:arm64",
  "codex:0.144.6:0.144.6:x64",
]);

export function evaluateSupport(input: SupportTuple):
  | { supported: true }
  | { supported: false; reason: string } {
  const key = `${input.provider}:${input.sdkVersion}:${input.cliVersion}:${input.architecture}`;
  if (SUPPORTED.has(key)) return { supported: true };
  const name = input.provider === "claude" ? "Claude" : "Codex";
  return {
    supported: false,
    reason: `Unsupported ${name} CLI ${input.cliVersion} for SDK ${input.sdkVersion} on ${input.architecture}`,
  };
}
```

The Claude rows above are private technical-compatibility seeds for the locally observed CLI version, not permission to expose Claude subscription auth in a public build. `PUBLIC_PROVIDER_RELEASE_POLICY.claudeSubscription` remains `false`; before any release, regenerate every enabled row from a controlled smoke run and the dated policy evidence required by Milestone 4. A missing or newer CLI tuple fails closed.

```ts
// src/worker/providers/executable-discovery.ts
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "../../shared/contracts/provider";
import type { ExecFileRunner } from "../process/exec-file";
import { evaluateSupport } from "./support-matrix";

export interface DetectedExecutable {
  provider: ProviderId;
  executableRealpath: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
}

const names: Record<ProviderId, string> = { claude: "claude", codex: "codex" };
const sdkVersions: Record<ProviderId, string> = { claude: "0.3.216", codex: "0.144.6" };

export function executableCandidates(provider: ProviderId, homeDirectory: string): string[] {
  const name = names[provider];
  const providerSpecific = provider === "claude"
    ? [join(homeDirectory, ".claude", "local", name)]
    : [];
  return [
    ...providerSpecific,
    join(homeDirectory, ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
}

export function parseProviderCliVersion(provider: ProviderId, stdout: string): string {
  const pattern = provider === "claude"
    ? /(?:claude(?: code)?\s+)?(\d+\.\d+\.\d+)/i
    : /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/i;
  const match = pattern.exec(stdout.trim());
  if (!match) throw new Error(`Unrecognized ${provider} version output`);
  return match[1];
}

export async function discoverExternalExecutable(input: {
  provider: ProviderId;
  selectedPath: string | null;
  homeDirectory: string;
  architecture: "arm64" | "x64";
  runner: ExecFileRunner;
}): Promise<DetectedExecutable | null> {
  const candidates = input.selectedPath
    ? [input.selectedPath, ...executableCandidates(input.provider, input.homeDirectory)]
    : executableCandidates(input.provider, input.homeDirectory);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isFile()) continue;
      await access(canonical, constants.X_OK);
      const result = await input.runner(canonical, ["--version"], {
        env: { HOME: input.homeDirectory, LANG: "C", LC_ALL: "C" },
        timeoutMs: 5_000,
        maxBufferBytes: 65_536,
      });
      const cliVersion = parseProviderCliVersion(input.provider, result.stdout);
      const support = evaluateSupport({
        provider: input.provider,
        sdkVersion: sdkVersions[input.provider],
        cliVersion,
        architecture: input.architecture,
      });
      if (!support.supported) continue;
      return { provider: input.provider, executableRealpath: canonical, cliVersion, architecture: input.architecture };
    } catch {
      continue;
    }
  }
  return null;
}
```

Keep selection order explicit; do not call `which`, `command -v`, a login shell, or `process.env.PATH`.

Extend Milestone 1's options type without changing its call shape:

```ts
// src/worker/process/exec-file.ts
export interface ExecFileOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxBufferBytes: number;
}
```

Pass `options.env` directly to Node `execFile` when present. Do not merge it with `process.env`.

- [ ] **Step 4: Run discovery and matrix tests**

Run: `pnpm exec vitest run tests/unit/providers/executable-discovery.test.ts tests/unit/providers/support-matrix.test.ts`

Expected: exit 0; all canonicalization, executable-bit, exact-version, and architecture cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/process/exec-file.ts src/worker/providers/support-matrix.ts src/worker/providers/executable-discovery.ts tests/unit/providers/executable-discovery.test.ts tests/unit/providers/support-matrix.test.ts
git commit -m "feat: discover supported external provider CLIs"
```

### Task 3: Build Adapter-Specific Environments, Authoritative Codex Config, and Fail-Closed Auth Probes

**Files:**
- Create: `src/worker/providers/provider-environment.ts`
- Create: `src/worker/providers/auth-probes.ts`
- Create: `src/shared/security/codex-config-lock.ts`
- Create: `resources/codex/0.144.6/subscription.config.lock.toml`
- Create: `config/codex-config-lock-manifest.json`
- Create: `tests/fixtures/providers/claude/auth-subscription.json`
- Create: `tests/fixtures/providers/claude/auth-api-key.json`
- Create: `tests/unit/providers/provider-environment.test.ts`
- Create: `tests/unit/providers/auth-probes.test.ts`
- Create: `tests/unit/providers/codex-config-lock.test.ts`

**Interfaces:**
- Consumes: `DetectedExecutable`, Milestone 1 `ExecFileRunner`, `ProviderId`, application resources realpath, and exact Codex CLI version `0.144.6`.
- Produces: `buildProviderEnvironment(input): Record<string, string>`, `validateCodexSubscriptionConfigLock(input): Promise<ValidatedCodexConfigLock>`, and `probeProviderAuth(input): Promise<ProviderAuthDecision>` where only `state: "subscription"` with the validated authoritative lock permits a Codex technical run; release policy is checked separately.

- [ ] **Step 1: Write failing environment, config-lock, and auth-precedence tests**

```ts
// tests/unit/providers/provider-environment.test.ts
import { describe, expect, it } from "vitest";
import { buildProviderEnvironment } from "../../../src/worker/providers/provider-environment";

describe("provider child environment", () => {
  it.each(["claude", "codex"] as const)("omits inherited credentials for %s", (provider) => {
    const env = buildProviderEnvironment({
      provider,
      executableRealpath: `/opt/homebrew/bin/${provider}`,
      homeDirectory: "/Users/tester",
      temporaryDirectory: "/private/tmp/tester",
      userName: "tester",
      approvedPathEntries: ["/Users/tester/project/node_modules/.bin"],
      source: {
        ANTHROPIC_API_KEY: "secret-a",
        CLAUDE_CODE_OAUTH_TOKEN: "secret-b",
        OPENAI_API_KEY: "secret-c",
        CODEX_API_KEY: "secret-d",
        ANTHROPIC_BASE_URL: "https://custom.invalid",
        OPENAI_BASE_URL: "https://custom.invalid",
        AWS_PROFILE: "prod",
        CLAUDE_CODE_USE_VERTEX: "1",
        NODE_OPTIONS: "--require /tmp/inject.cjs",
      },
    });
    expect(env).toEqual({
      HOME: "/Users/tester",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      LOGNAME: "tester",
      PATH: `/opt/homebrew/bin:/Users/tester/project/node_modules/.bin:/usr/bin:/bin`,
      SHELL: "/bin/zsh",
      TMPDIR: "/private/tmp/tester",
      USER: "tester",
    });
  });
});
```

```ts
// tests/unit/providers/auth-probes.test.ts
import { describe, expect, it, vi } from "vitest";
import { probeProviderAuth } from "../../../src/worker/providers/auth-probes";

describe("provider auth probes", () => {
  it("accepts explicit Claude subscription status from the same executable", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      stderr: "",
    });
    await expect(probeProviderAuth({
      provider: "claude",
      executableRealpath: "/real/claude",
      env: { HOME: "/Users/tester" },
      runner,
    })).resolves.toEqual({ state: "subscription", display: "Claude Max" });
    expect(runner).toHaveBeenCalledWith(
      "/real/claude",
      ["auth", "status", "--json"],
      expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }),
    );
  });

  it.each([
    [{ loggedIn: true, authMethod: "api_key" }, "api_key"],
    [{ loggedIn: true, authMethod: "bedrock" }, "bedrock"],
    [{ loggedIn: true, authMethod: "vertex" }, "vertex"],
    [{ loggedIn: true, authMethod: "foundry" }, "foundry"],
  ])("blocks Claude non-subscription auth %#", async (payload, mode) => {
    const runner = vi.fn().mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "" });
    await expect(probeProviderAuth({
      provider: "claude",
      executableRealpath: "/real/claude",
      env: {},
      runner,
    })).resolves.toEqual({ state: "blocked", reason: `Unsupported Claude auth mode: ${mode}` });
  });

  it("accepts only the exact Codex ChatGPT status", async () => {
    const readyRunner = vi.fn().mockResolvedValue({ stdout: "Logged in using ChatGPT\n", stderr: "" });
    await expect(probeProviderAuth({
      provider: "codex",
      executableRealpath: "/real/codex",
      codexConfigLockRealpath: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml",
      env: {},
      runner: readyRunner,
    })).resolves.toEqual({ state: "subscription", display: "ChatGPT" });
    expect(readyRunner).toHaveBeenCalledWith(
      "/real/codex",
      [
        "login", "status",
        "--config", "debug.config_lockfile.load_path=\"/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml\"",
        "--config", "debug.config_lockfile.allow_codex_version_mismatch=false",
      ],
      expect.objectContaining({ timeoutMs: 5_000, maxBufferBytes: 65_536 }),
    );

    const keyRunner = vi.fn().mockResolvedValue({ stdout: "Logged in using an API key\n", stderr: "" });
    await expect(probeProviderAuth({
      provider: "codex",
      executableRealpath: "/real/codex",
      codexConfigLockRealpath: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml",
      env: {},
      runner: keyRunner,
    })).resolves.toEqual({ state: "blocked", reason: "Unsupported Codex auth mode: api_key" });
  });

  it("blocks unknown output without reading auth storage", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "Signed in somehow\n", stderr: "" });
    await expect(probeProviderAuth({
      provider: "codex",
      executableRealpath: "/real/codex",
      codexConfigLockRealpath: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml",
      env: {},
      runner,
    })).resolves.toEqual({ state: "unknown", reason: "Unrecognized Codex auth status" });
  });
});
```

- [ ] **Step 2: Run tests and verify the environment/auth/config-lock modules are absent**

Run: `pnpm exec vitest run tests/unit/providers/provider-environment.test.ts tests/unit/providers/auth-probes.test.ts tests/unit/providers/codex-config-lock.test.ts`

Expected: FAIL with missing-module errors for `provider-environment` and `codex-config-lock`.

- [ ] **Step 3: Implement explicit allowlists and same-executable probes**

```ts
// src/worker/providers/provider-environment.ts
import { dirname } from "node:path";
import type { ProviderId } from "../../shared/contracts/provider";

export function buildProviderEnvironment(input: {
  provider: ProviderId;
  executableRealpath: string;
  homeDirectory: string;
  temporaryDirectory: string;
  userName: string;
  approvedPathEntries: readonly string[];
  source: NodeJS.ProcessEnv;
}): Record<string, string> {
  void input.provider;
  void input.source;
  const path = [
    dirname(input.executableRealpath),
    ...input.approvedPathEntries,
    "/usr/bin",
    "/bin",
  ].filter((entry, index, values) => values.indexOf(entry) === index);
  return {
    HOME: input.homeDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: input.userName,
    PATH: path.join(":"),
    SHELL: "/bin/zsh",
    TMPDIR: input.temporaryDirectory,
    USER: input.userName,
  };
}
```

```ts
// src/worker/providers/auth-probes.ts
import { z } from "zod";
import type { ProviderId } from "../../shared/contracts/provider";
import type { ExecFileRunner } from "../process/exec-file";

export type ProviderAuthDecision =
  | { state: "subscription"; display: string }
  | { state: "blocked" | "unknown" | "signed_out"; reason: string };

const ClaudeSubscriptionSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal("claude.ai"),
  subscriptionType: z.enum(["free", "pro", "max"]),
}).passthrough();

export async function probeProviderAuth(input: {
  provider: ProviderId;
  executableRealpath: string;
  codexConfigLockRealpath?: string;
  env: Record<string, string>;
  runner: ExecFileRunner;
}): Promise<ProviderAuthDecision> {
  let args: string[];
  if (input.provider === "claude") {
    args = ["auth", "status", "--json"];
  } else {
    if (!input.codexConfigLockRealpath) {
      return { state: "blocked", reason: "Validated Codex subscription config lock is required" };
    }
    args = [
      "login", "status",
      "--config", `debug.config_lockfile.load_path=${JSON.stringify(input.codexConfigLockRealpath)}`,
      "--config", "debug.config_lockfile.allow_codex_version_mismatch=false",
    ];
  }
  let result: { stdout: string; stderr: string };
  try {
    result = await input.runner(input.executableRealpath, args, {
      env: input.env,
      timeoutMs: 5_000,
      maxBufferBytes: 65_536,
    });
  } catch {
    return { state: "signed_out", reason: `${input.provider} is not logged in` };
  }

  if (input.provider === "codex") {
    const status = result.stdout.trim();
    if (status === "Logged in using ChatGPT") return { state: "subscription", display: "ChatGPT" };
    if (status === "Logged in using an API key") return { state: "blocked", reason: "Unsupported Codex auth mode: api_key" };
    if (status === "Not logged in") return { state: "signed_out", reason: "codex is not logged in" };
    return { state: "unknown", reason: "Unrecognized Codex auth status" };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); } catch { return { state: "unknown", reason: "Unrecognized Claude auth status" }; }
  const subscription = ClaudeSubscriptionSchema.safeParse(parsed);
  if (subscription.success) {
    const label = subscription.data.subscriptionType[0].toUpperCase() + subscription.data.subscriptionType.slice(1);
    return { state: "subscription", display: `Claude ${label}` };
  }
  const mode = z.object({ authMethod: z.string() }).passthrough().safeParse(parsed);
  if (mode.success) return { state: "blocked", reason: `Unsupported Claude auth mode: ${mode.data.authMethod}` };
  return { state: "unknown", reason: "Unrecognized Claude auth status" };
}
```

`src/shared/security/codex-config-lock.ts` accepts only the regular, non-symlink resource file under the canonical application resources root, caps it at 512 KiB, verifies exact size and SHA-256 against the strict checked-in manifest, requires lock `version = 1` and `codex_version = "0.144.6"`, and returns a branded canonical realpath. It is a Node-only security module imported by worker/Provider-runner entries; add it to the Renderer forbidden-import test. The manifest permits only `{ schemaVersion: 1, cliVersion: "0.144.6", repositoryPath, packagedRelativePath, bytes, sha256 }`, with `sha256` matching `^sha256:[a-f0-9]{64}$`; reject unknown fields. The reviewed lock is generated once by the exact supported external CLI using `debug.config_lockfile.export_dir` with a clean temporary `HOME`/`CODEX_HOME`, `model_provider="openai"`, the official `chatgpt_base_url`, and empty `model_providers`/`mcp_servers`; stop after `thread.started`, before any useful prompt is sent. Review the complete generated lock before committing it, compute the manifest size/hash from those exact bytes, and reject any occurrence of credential material, non-OpenAI provider selection, custom endpoint, configured MCP server, hook/notifier command, or version-mismatch allowance. Never copy an auth file or token into the generation directory.

The unit lock test corrupts one byte, substitutes a symlink, changes `codex_version`, and supplies a reviewed-hash mismatch; each case must block before either `login status` or the SDK runs. It also proves the committed lock names only the built-in `openai` provider and official ChatGPT endpoint. `HOME` remains the user's real home solely so the official CLI can reach its own ChatGPT credential store; ordinary home/project configuration is not trusted because every Codex probe and run loads the authoritative lock.

The two fixture JSON files contain exactly the subscription and `api_key` objects used above, with no email, account ID, token, path, or organization value. Add table cases for environment token inputs and unknown fields. Custom-endpoint precedence is tested with malicious home and project configs against the real lock construction in Task 11 and the release smoke in Task 14; merely omitting endpoint environment variables is not counted as proof.

- [ ] **Step 4: Run the auth precedence matrix**

Run: `pnpm exec vitest run tests/unit/providers/provider-environment.test.ts tests/unit/providers/auth-probes.test.ts tests/unit/providers/codex-config-lock.test.ts`

Expected: exit 0; subscription, stored API-key, environment token, lock hash/path/version failures, Bedrock, Vertex, Foundry, signed-out, and unknown-output cases all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/providers/provider-environment.ts src/worker/providers/auth-probes.ts src/shared/security/codex-config-lock.ts resources/codex/0.144.6/subscription.config.lock.toml config/codex-config-lock-manifest.json tests/fixtures/providers/claude/auth-subscription.json tests/fixtures/providers/claude/auth-api-key.json tests/unit/providers/provider-environment.test.ts tests/unit/providers/auth-probes.test.ts tests/unit/providers/codex-config-lock.test.ts
git commit -m "feat: enforce subscription-only provider auth and config"
```

### Task 4: Persist Provider Health and Add Narrow Worker/Main Commands

**Files:**
- Create: `src/worker/storage/provider-repository.ts`
- Modify: `src/worker/storage/migrations.ts`
- Modify: `src/worker/storage/repositories.ts`
- Create: `src/worker/providers/provider-health-service.ts`
- Create: `src/worker/providers/provider-command-handlers.ts`
- Modify: `src/shared/contracts/domain.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/shared/contracts/renderer-api.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Modify: `src/main/ipc/renderer-gateway.ts`
- Create: `tests/helpers/provider-test-harness.ts`
- Create: `tests/integration/providers/provider-health-service.test.ts`
- Create: `tests/unit/protocol/provider-health-protocol.test.ts`

**Interfaces:**
- Consumes: `discoverExternalExecutable`, `buildProviderEnvironment`, `validateCodexSubscriptionConfigLock`, `probeProviderAuth`, `PUBLIC_PROVIDER_RELEASE_POLICY`, Milestone 1 `Database`/`idempotency_records`/`CommandHandler`, and the existing Main-only file-dialog path injection pattern.
- Produces: `ProviderRepository`, `ProviderHealthService.list()`, `ProviderHealthService.selectExecutable(provider, selectedPath)`, renderer command `provider.pickExecutable { provider }`, worker-only command `provider.executableSelected { provider, selectedPath }`, and worker command `provider.health.list {}`.

- [ ] **Step 1: Write failing persistence and protocol-boundary tests**

```ts
// tests/unit/protocol/provider-health-protocol.test.ts
import { describe, expect, it } from "vitest";
import { RendererRequestEnvelopeSchema, WorkerRequestEnvelopeSchema } from "../../../src/shared/contracts/protocol";

describe("provider health protocol", () => {
  it("lets Renderer request a picker without supplying a path", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      v: 1,
      requestId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "pick-codex-1",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      type: "provider.pickExecutable",
      payload: { provider: "codex" },
    }).payload).toEqual({ provider: "codex" });
  });

  it("rejects a forged Renderer-selected path", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      v: 1,
      requestId: "22222222-2222-4222-8222-222222222222",
      idempotencyKey: "forged",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      type: "provider.executableSelected",
      payload: { provider: "codex", selectedPath: "/tmp/fake-codex" },
    })).toThrow();
  });

  it("accepts the Main-injected worker command", () => {
    expect(WorkerRequestEnvelopeSchema.parse({
      v: 1,
      requestId: "33333333-3333-4333-8333-333333333333",
      idempotencyKey: "selected-codex-1",
      workerGeneration: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      type: "provider.executableSelected",
      payload: { provider: "codex", selectedPath: "/opt/homebrew/bin/codex" },
    }).type).toBe("provider.executableSelected");
  });
});
```

```ts
// tests/integration/providers/provider-health-service.test.ts
import { describe, expect, it } from "vitest";
import { createProviderTestHarness } from "../../helpers/provider-test-harness";

describe("ProviderHealthService", () => {
  it("stores health metadata but no auth material", async () => {
    const harness = await createProviderTestHarness({
      provider: "codex",
      versionOutput: "codex-cli 0.144.6\n",
      authOutput: "Logged in using ChatGPT\n",
    });
    const health = await harness.service.selectExecutable(
      "codex",
      harness.executablePath,
    );
    expect(health.state).toBe("ready");
    expect(health.authLabel).toBe("Subscription-only");
    const row = harness.db.prepare("SELECT * FROM provider_installations WHERE provider = ?").get("codex") as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([
      "architecture",
      "checked_at",
      "cli_version",
      "executable_realpath",
      "provider",
      "state",
    ]);
  });

  it("reports a technically healthy Claude CLI as public-policy disabled", async () => {
    const harness = await createProviderTestHarness({
      provider: "claude",
      versionOutput: "2.1.206\n",
      authOutput: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    });
    const health = await harness.service.selectExecutable(
      "claude",
      harness.executablePath,
    );
    expect(health.state).toBe("policy_disabled");
    expect(health.repairAction).toContain("written Anthropic approval");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify schema/service failures**

Run: `pnpm exec vitest run tests/unit/protocol/provider-health-protocol.test.ts tests/integration/providers/provider-health-service.test.ts`

Expected: FAIL because `provider.pickExecutable` is not in the protocol union and `provider_installations` does not exist.

- [ ] **Step 3: Add the credential-free migration and repository**

```sql
-- SQL registered as logical migration 003_provider_runtime in src/worker/storage/migrations.ts
CREATE TABLE provider_installations (
  provider TEXT PRIMARY KEY CHECK (provider IN ('claude', 'codex')),
  executable_realpath TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture IN ('arm64', 'x64')),
  state TEXT NOT NULL CHECK (state IN ('missing', 'incompatible', 'unauthenticated', 'policy_disabled', 'ready')),
  checked_at TEXT NOT NULL
);

CREATE TABLE context_bundles (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL CHECK (version > 0),
  hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, version),
  UNIQUE (run_id, hash)
);

CREATE TABLE provider_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  provider_seq INTEGER NOT NULL CHECK (provider_seq >= 0),
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (run_id, provider_seq)
);

CREATE TABLE provider_sessions (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
  provider_session_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  last_provider_seq INTEGER NOT NULL DEFAULT 0,
  resume_state TEXT NOT NULL CHECK (resume_state IN ('active', 'interrupted', 'resumable', 'replaced', 'closed')),
  updated_at TEXT NOT NULL
);

CREATE INDEX provider_sessions_provider_id_idx
  ON provider_sessions(provider, provider_session_id);

ALTER TABLE operation_journal ADD COLUMN process_identity_json TEXT;
ALTER TABLE operation_journal ADD COLUMN provider_run_id TEXT;
ALTER TABLE operation_journal ADD COLUMN last_signal TEXT;
ALTER TABLE operation_journal ADD COLUMN signal_observed_at TEXT;
```

`provider-repository.ts` exposes only typed methods for installation metadata, raw event append, context bundles, and session IDs. It has no token/auth-JSON column or method. Wire one instance into `DomainRepositories` and execute this migration through the existing ordered `runMigrations` transaction.

- [ ] **Step 4: Implement the health service and protocol routing**

```ts
// src/worker/providers/provider-health-service.ts
export class ProviderHealthService {
  constructor(private readonly deps: ProviderHealthDependencies) {}

  async list(): Promise<ProviderHealth[]> {
    return Promise.all((["claude", "codex"] as const).map((provider) => this.refresh(provider)));
  }

  async selectExecutable(
    provider: ProviderId,
    selectedPath: string,
  ): Promise<ProviderHealth> {
    return this.refresh(provider, selectedPath);
  }

  private async refresh(provider: ProviderId, selectedPath?: string): Promise<ProviderHealth> {
    const saved = this.deps.repository.getInstallation(provider);
    const detected = await discoverExternalExecutable({
      provider,
      selectedPath: selectedPath ?? saved?.executableRealpath ?? null,
      homeDirectory: this.deps.host.homeDirectory,
      architecture: this.deps.host.architecture,
      runner: this.deps.runner,
    });
    if (!detected) return this.deps.missingHealth(provider);
    const env = this.deps.buildEnvironment(provider, detected.executableRealpath);
    let codexConfigLockRealpath: string | undefined;
    if (provider === "codex") {
      const lock = await this.deps.validateCodexSubscriptionConfigLock({
        resourcesRootRealpath: this.deps.host.resourcesRootRealpath,
        expectedCliVersion: detected.cliVersion,
      });
      if (!lock.valid) return this.deps.incompatibleHealth(provider, lock.reason);
      codexConfigLockRealpath = lock.realpath;
    }
    const auth = await probeProviderAuth({
      provider,
      executableRealpath: detected.executableRealpath,
      codexConfigLockRealpath,
      env,
      runner: this.deps.runner,
    });
    const state = auth.state !== "subscription"
      ? "unauthenticated"
      : provider === "claude" && !PUBLIC_PROVIDER_RELEASE_POLICY.claudeSubscription.enabled
        ? "policy_disabled"
        : "ready";
    const health = this.deps.toSanitizedHealth(detected, state);
    this.deps.repository.upsertInstallation({
      provider,
      executableRealpath: detected.executableRealpath,
      cliVersion: detected.cliVersion,
      architecture: detected.architecture,
      state,
      checkedAt: this.deps.clock.now(),
    });
    return health;
  }
}
```

`ProviderExecutableSelectedHandler` and `ProviderHealthListHandler` implement the existing `CommandHandler<TType>` interface. Register them in `createWorkerRouter`; the existing handler pipeline writes `idempotency_records` before acknowledging state-changing commands. Discovery and auth probing happen before the synchronous repository upsert transaction. Extend the protocol unions with exact Zod payloads, and add `provider.pickExecutable` to Main's file dialog handler with file-only selection. Renderer can request a picker but never submit a path.

Do not persist the lock realpath as user data. Resolve and hash-validate the packaged resource again immediately before every Codex runner start/resume, then place that branded path in the runner command. A successful onboarding probe cannot authorize a later run if the resource, CLI version, or hash has changed.

- [ ] **Step 5: Run storage, protocol, and type checks**

Run: `pnpm exec vitest run tests/unit/protocol/provider-health-protocol.test.ts tests/integration/providers/provider-health-service.test.ts && pnpm typecheck`

Expected: exit 0; path-forgery rejection, credential-free schema, public Claude policy, idempotent selection, and type checks PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/storage/provider-repository.ts src/worker/storage/migrations.ts src/worker/storage/repositories.ts src/worker/providers/provider-health-service.ts src/worker/providers/provider-command-handlers.ts src/shared/contracts/domain.ts src/shared/contracts/protocol.ts src/shared/contracts/renderer-api.ts src/worker/protocol/worker-router.ts src/main/ipc/renderer-gateway.ts tests/helpers/provider-test-harness.ts tests/integration/providers/provider-health-service.test.ts tests/unit/protocol/provider-health-protocol.test.ts
git commit -m "feat: persist sanitized provider health"
```

### Task 5: Render Onboarding Provider Health Without Exposing Credentials

**Files:**
- Create: `src/renderer/features/onboarding/ProviderHealthCard.tsx`
- Create: `src/renderer/features/onboarding/ProviderHealthStep.tsx`
- Modify: `src/renderer/state/timeline-store.ts`
- Modify: `src/renderer/App.tsx`
- Create: `tests/unit/renderer/ProviderHealthStep.test.tsx`
- Modify: `tests/unit/renderer/timeline-store.test.ts`

**Interfaces:**
- Consumes: `ProviderHealth[]`, `BranchestraApi.request`, existing snapshot hydration, and the `provider.health.list` / `provider.pickExecutable` commands from Task 4.
- Produces: `TimelineStore.providerHealth`, `refreshProviderHealth()`, `pickProviderExecutable(provider)`, `ProviderHealthStep`, and one non-secret `ProviderHealthCard` per Provider.

- [ ] **Step 1: Write the failing onboarding rendering test**

```tsx
// @vitest-environment jsdom
// tests/unit/renderer/ProviderHealthStep.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderHealthStep } from "../../../src/renderer/features/onboarding/ProviderHealthStep";

describe("ProviderHealthStep", () => {
  it("shows local/auth boundaries, repair state, and no credential detail", async () => {
    const pick = vi.fn();
    render(<ProviderHealthStep
      health={[
        {
          provider: "claude",
          state: "policy_disabled",
          executableRealpath: "/opt/homebrew/bin/claude",
          cliVersion: "2.1.206",
          sdkVersion: "0.3.216",
          architecture: "arm64",
          authLabel: "Subscription-only",
          capabilities: null,
          repairAction: "Public Claude runs require written Anthropic approval.",
        },
        {
          provider: "codex",
          state: "ready",
          executableRealpath: "/opt/homebrew/bin/codex",
          cliVersion: "0.144.6",
          sdkVersion: "0.144.6",
          architecture: "arm64",
          authLabel: "Subscription-only",
          capabilities: null,
          repairAction: null,
        },
      ]}
      onPick={pick}
      onRefresh={vi.fn()}
    />);
    expect(screen.getByText(/saved on this Mac/i)).not.toBeNull();
    expect(screen.getByText(/context is sent to the selected provider/i)).not.toBeNull();
    expect(screen.getAllByText("Subscription-only")).toHaveLength(2);
    expect(screen.getByText("Public Claude runs require written Anthropic approval.")).not.toBeNull();
    expect(screen.queryByText(/token|api key|account id/i)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Choose Codex CLI" }));
    expect(pick).toHaveBeenCalledWith("codex");
  });
});
```

- [ ] **Step 2: Run the renderer test and verify the component is absent**

Run: `pnpm exec vitest run tests/unit/renderer/ProviderHealthStep.test.tsx`

Expected: FAIL with `Cannot find module '../../../src/renderer/features/onboarding/ProviderHealthStep'`.

- [ ] **Step 3: Implement the health card, onboarding step, and store methods**

```tsx
// src/renderer/features/onboarding/ProviderHealthCard.tsx
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";

export function ProviderHealthCard(props: {
  health: ProviderHealth;
  onPick(provider: ProviderId): void;
}) {
  const name = props.health.provider === "claude" ? "Claude" : "Codex";
  return <section aria-label={`${name} health`}>
    <h3>{name}</h3>
    <p>{props.health.authLabel}</p>
    <dl>
      <dt>CLI</dt><dd>{props.health.executableRealpath ?? "Not found"}</dd>
      <dt>Version</dt><dd>{props.health.cliVersion ?? "Unavailable"}</dd>
      <dt>Status</dt><dd>{props.health.state.replaceAll("_", " ")}</dd>
    </dl>
    {props.health.repairAction ? <p role="status">{props.health.repairAction}</p> : null}
    <button type="button" onClick={() => props.onPick(props.health.provider)}>
      Choose {name} CLI
    </button>
  </section>;
}
```

```tsx
// src/renderer/features/onboarding/ProviderHealthStep.tsx
import type { ProviderHealth, ProviderId } from "../../../shared/contracts/provider";
import { ProviderHealthCard } from "./ProviderHealthCard";

export function ProviderHealthStep(props: {
  health: readonly ProviderHealth[];
  onPick(provider: ProviderId): void;
  onRefresh(): void;
}) {
  return <section aria-labelledby="provider-health-title">
    <h2 id="provider-health-title">Connect external coding agents</h2>
    <p>Branchestra history and Git results are saved on this Mac.</p>
    <p>When an Agent runs, selected chat, code, diffs, and tool results in its context are sent to the selected provider.</p>
    <p>Install and sign in with each official CLI outside Branchestra. Branchestra never stores or displays credentials.</p>
    <div>{props.health.map((item) =>
      <ProviderHealthCard key={item.provider} health={item} onPick={props.onPick} />
    )}</div>
    <button type="button" onClick={props.onRefresh}>Check again</button>
  </section>;
}
```

Extend `createTimelineStore` with `providerHealth: []`, `refreshProviderHealth()` sending `provider.health.list`, and `pickProviderExecutable(provider)` sending only `{ provider }`. After Main returns from the picker, refresh health. Render `ProviderHealthStep` in the existing onboarding region of `App.tsx`; do not create another app shell or transport.

- [ ] **Step 4: Run component, store, and accessibility tests**

Run: `pnpm exec vitest run tests/unit/renderer/ProviderHealthStep.test.tsx tests/unit/renderer/timeline-store.test.ts && pnpm typecheck`

Expected: exit 0; disclosure copy, sanitized metadata, empty-path request, refresh behavior, and type checks PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/features/onboarding/ProviderHealthCard.tsx src/renderer/features/onboarding/ProviderHealthStep.tsx src/renderer/state/timeline-store.ts src/renderer/App.tsx tests/unit/renderer/ProviderHealthStep.test.tsx tests/unit/renderer/timeline-store.test.ts
git commit -m "feat: show provider onboarding health"
```

### Task 6: Build and Persist Deterministic Shared Context Bundles

**Files:**
- Create: `src/worker/context/context-builder.ts`
- Create: `src/worker/context/context-repository.ts`
- Create: `src/worker/context/stable-json.ts`
- Modify: `src/worker/storage/provider-repository.ts`
- Create: `tests/unit/context/context-builder.test.ts`
- Create: `tests/integration/providers/context-persistence.test.ts`

**Interfaces:**
- Consumes: room/task/approval data, `EventStore.after`, task/checkpoint/test repositories, and the Task 4 `context_bundles` table.
- Produces: `ContextBuilder.build(input): Promise<ContextBundle>`, `ContextSource`, `ContextRepository.save(bundle, runId)`, `ContextRepository.getByHash(runId, hash)`, and `stableJson(value): string`.

- [ ] **Step 1: Write failing selection and hash tests**

```ts
// tests/unit/context/context-builder.test.ts
import { describe, expect, it } from "vitest";
import { ContextBuilder } from "../../../src/worker/context/context-builder";

const message = (eventId: string, roomSeq: number, author: "user" | "claude" | "codex", body: string) =>
  ({ eventId, roomSeq, author, body });

describe("ContextBuilder", () => {
  it("combines current, memory, relevant history, and peer artifacts", async () => {
    const source = {
      nextVersion: async () => 4,
      recentMessages: async () => [message("e-9", 9, "user", "Keep the protocol narrow")],
      roomMemory: async () => ({ summaryVersion: 3, summary: "Build adapters", decisions: ["No API fallback"] }),
      relevantMessages: async () => [message("e-2", 2, "claude", "Use raw-event-first persistence")],
      peerArtifacts: async () => ({
        messages: [message("e-8", 8, "codex", "The fixture passes")],
        checkpointOid: "a".repeat(40),
        diffSummary: "2 files changed",
        tests: ["pnpm test:unit: pass"],
        toolSummaries: ["git.status: clean"],
      }),
    };
    const builder = new ContextBuilder(source);
    const input = {
      runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      roomId: "room-1",
      taskId: "task-1",
      role: "lead" as const,
      instruction: "Implement provider adapters",
      approvedScope: "write only the lead worktree",
      lead: "claude" as const,
    };
    const first = await builder.build(input);
    const second = await builder.build(input);
    expect(first.payload.recentVerbatim[0].body).toBe("Keep the protocol narrow");
    expect(first.payload.roomMemory.decisions).toEqual(["No API fallback"]);
    expect(first.payload.relevantHistory[0].eventId).toBe("e-2");
    expect(first.payload.peer.checkpointOid).toBe("a".repeat(40));
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.hash).toBe(first.hash);
  });

  it("changes the hash when a confirmed decision changes", async () => {
    let decision = "Network off";
    const source = {
      nextVersion: async () => 1,
      recentMessages: async () => [],
      roomMemory: async () => ({ summaryVersion: 1, summary: "Adapter", decisions: [decision] }),
      relevantMessages: async () => [],
      peerArtifacts: async () => ({ messages: [], checkpointOid: null, diffSummary: null, tests: [], toolSummaries: [] }),
    };
    const builder = new ContextBuilder(source);
    const input = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", roomId: "r", taskId: "t", role: "collaborator" as const, instruction: "Review", approvedScope: "read", lead: "codex" as const };
    const before = await builder.build(input);
    decision = "Network on";
    const after = await builder.build(input);
    expect(after.hash).not.toBe(before.hash);
  });
});
```

- [ ] **Step 2: Run the context tests and verify the builder is absent**

Run: `pnpm exec vitest run tests/unit/context/context-builder.test.ts tests/integration/providers/context-persistence.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/context/context-builder'`.

- [ ] **Step 3: Implement canonical serialization and exact selection limits**

```ts
// src/worker/context/stable-json.ts
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
```

```ts
// src/worker/context/context-builder.ts
import { createHash } from "node:crypto";
import type { ContextBundle, ContextBundlePayload, ContextMessage, ProviderId } from "../../shared/contracts/provider";
import { stableJson } from "./stable-json";

export interface ContextSource {
  nextVersion(runId: string): Promise<number>;
  recentMessages(roomId: string, limit: 40): Promise<readonly ContextMessage[]>;
  roomMemory(roomId: string): Promise<ContextBundlePayload["roomMemory"]>;
  relevantMessages(input: { roomId: string; taskId: string; queryTerms: readonly string[]; excludeEventIds: readonly string[]; limit: 20 }): Promise<readonly ContextMessage[]>;
  peerArtifacts(input: { taskId: string; role: "lead" | "collaborator"; messageLimit: 12 }): Promise<ContextBundlePayload["peer"]>;
}

export interface BuildContextInput {
  runId: string;
  roomId: string;
  taskId: string;
  role: "lead" | "collaborator";
  instruction: string;
  approvedScope: string;
  lead: ProviderId;
  injectedReadOnlySnapshot?: string | null;
}

export class ContextBuilder {
  constructor(private readonly source: ContextSource) {}

  async build(input: BuildContextInput): Promise<ContextBundle> {
    const recentVerbatim = [...await this.source.recentMessages(input.roomId, 40)].sort((a, b) => a.roomSeq - b.roomSeq);
    const queryTerms = [...new Set((input.instruction.toLowerCase().match(/[a-z0-9_/-]{3,}/g) ?? []).slice(0, 12))];
    const [version, roomMemory, relevantHistory, peer] = await Promise.all([
      this.source.nextVersion(input.runId),
      this.source.roomMemory(input.roomId),
      this.source.relevantMessages({ roomId: input.roomId, taskId: input.taskId, queryTerms, excludeEventIds: recentVerbatim.map((item) => item.eventId), limit: 20 }),
      this.source.peerArtifacts({ taskId: input.taskId, role: input.role, messageLimit: 12 }),
    ]);
    const payload: ContextBundlePayload = {
      task: { instruction: input.instruction, approvedScope: input.approvedScope, lead: input.lead },
      recentVerbatim,
      roomMemory,
      relevantHistory: [...relevantHistory].sort((a, b) => a.roomSeq - b.roomSeq),
      peer,
      injectedReadOnlySnapshot: input.injectedReadOnlySnapshot ?? null,
    };
    const hash = createHash("sha256").update(stableJson({ roomId: input.roomId, taskId: input.taskId, role: input.role, payload })).digest("hex");
    return { version, hash, roomId: input.roomId, taskId: input.taskId, role: input.role, payload };
  }
}
```

`ContextRepository.save` inserts the full canonical payload, version, and hash in one transaction and returns the same bundle. `getByHash` parses it through a Zod schema derived from `ContextBundle`; duplicate `(run_id, hash)` returns the existing row. Repository queries use the canonical room event store and task artifacts, never Provider transcripts as the sole history source.

- [ ] **Step 4: Run context, persistence, and deterministic-order tests**

Run: `pnpm exec vitest run tests/unit/context/context-builder.test.ts tests/integration/providers/context-persistence.test.ts`

Expected: exit 0; recent limit 40, relevant limit 20, peer limit 12, decision/hash changes, stable ordering, duplicate save, and SQLite reopen cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/context/context-builder.ts src/worker/context/context-repository.ts src/worker/context/stable-json.ts src/worker/storage/provider-repository.ts tests/unit/context/context-builder.test.ts tests/integration/providers/context-persistence.test.ts
git commit -m "feat: build durable shared agent context"
```

### Task 7: Expose Bounded Read-Only Context and Git Tools

**Files:**
- Create: `src/worker/tools/read-only-tool-service.ts`
- Create: `src/worker/tools/tool-bridge.ts`
- Create: `src/worker/tools/tool-schemas.ts`
- Create: `tests/unit/tools/read-only-tool-service.test.ts`
- Create: `tests/integration/providers/read-only-git-tools.test.ts`

**Interfaces:**
- Consumes: Milestone 2 `GitReadService.status/diff/show/log`, `RepositoryIdentity`, task-owned checkpoint OIDs, `WorkspacePathGuard`, and `ContextRepository.search/read`.
- Produces: `ReadOnlyToolService.execute(binding, request): Promise<ReadOnlyToolResult>`, the six exact tool names `context.search`, `context.read`, `git.status`, `git.diff`, `git.show`, `git.log`, and `ToolBridge.handle(call)`.

- [ ] **Step 1: Write failing dispatch and authorization tests**

```ts
// tests/unit/tools/read-only-tool-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { ReadOnlyToolService } from "../../../src/worker/tools/read-only-tool-service";

const binding = {
  roomId: "room-1",
  taskId: "task-1",
  repositoryRootRealpath: "/repo",
  worktreePathRealpath: "/worktrees/task-1/lead",
  startOid: "1".repeat(40),
  checkpointOids: new Set(["1".repeat(40), "2".repeat(40)]),
};

describe("ReadOnlyToolService", () => {
  it("binds git.status to the run worktree instead of caller paths", async () => {
    const git = { status: vi.fn().mockResolvedValue({ clean: true, entries: [] }) };
    const service = new ReadOnlyToolService({ git: git as never, context: {} as never });
    await expect(service.execute(binding, { name: "git.status", input: {} })).resolves.toEqual({
      content: JSON.stringify({ clean: true, entries: [] }),
      truncated: false,
    });
    expect(git.status).toHaveBeenCalledWith({ repositoryRootRealpath: "/repo", worktreePathRealpath: "/worktrees/task-1/lead" });
  });

  it("rejects arbitrary revisions and every unregistered mutation name", async () => {
    const service = new ReadOnlyToolService({ git: {} as never, context: {} as never });
    await expect(service.execute(binding, {
      name: "git.show",
      input: { checkpointOid: "f".repeat(40) },
    })).rejects.toThrow("Checkpoint is not owned by task task-1");
    await expect(service.execute(binding, {
      name: "git.commit",
      input: {},
    } as never)).rejects.toThrow("Unknown read-only tool: git.commit");
  });

  it("scopes context reads to the bound room", async () => {
    const context = { read: vi.fn().mockResolvedValue([{ eventId: "e-1", roomId: "room-1", body: "decision" }]) };
    const service = new ReadOnlyToolService({ git: {} as never, context: context as never });
    await service.execute(binding, { name: "context.read", input: { eventIds: ["e-1"] } });
    expect(context.read).toHaveBeenCalledWith({ roomId: "room-1", eventIds: ["e-1"], limit: 50 });
  });
});
```

- [ ] **Step 2: Run focused tool tests and verify the service is absent**

Run: `pnpm exec vitest run tests/unit/tools/read-only-tool-service.test.ts tests/integration/providers/read-only-git-tools.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/tools/read-only-tool-service'`.

- [ ] **Step 3: Add strict schemas and exhaustive read-only dispatch**

```ts
// src/worker/tools/tool-schemas.ts
import { z } from "zod";

const Oid = z.string().regex(/^[a-f0-9]{40,64}$/);
export const ReadOnlyToolRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("context.search"), input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(10) }).strict() }),
  z.object({ name: z.literal("context.read"), input: z.object({ eventIds: z.array(z.string().min(1)).min(1).max(50) }).strict() }),
  z.object({ name: z.literal("git.status"), input: z.object({}).strict() }),
  z.object({ name: z.literal("git.diff"), input: z.object({ fromOid: Oid, toOid: Oid.optional(), pathspec: z.array(z.string().min(1)).max(50).optional() }).strict() }),
  z.object({ name: z.literal("git.show"), input: z.object({ checkpointOid: Oid, path: z.string().min(1).optional() }).strict() }),
  z.object({ name: z.literal("git.log"), input: z.object({ startOid: Oid, maxCount: z.number().int().min(1).max(50).default(20) }).strict() }),
]);
export type ReadOnlyToolRequest = z.infer<typeof ReadOnlyToolRequestSchema>;
```

```ts
// src/worker/tools/read-only-tool-service.ts
import type { GitReadService } from "../git/repository-inspector";
import type { ReadOnlyToolRequest } from "./tool-schemas";

const MAX_RESULT_BYTES = 131_072;

export interface ReadOnlyToolBinding {
  roomId: string;
  taskId: string;
  repositoryRootRealpath: string;
  worktreePathRealpath: string;
  startOid: string;
  checkpointOids: ReadonlySet<string>;
}

export class ReadOnlyToolService {
  constructor(private readonly deps: { git: GitReadService; context: ContextReadRepository }) {}

  async execute(binding: ReadOnlyToolBinding, request: ReadOnlyToolRequest): Promise<{ content: string; truncated: boolean }> {
    let value: unknown;
    switch (request.name) {
      case "context.search": value = await this.deps.context.search({ roomId: binding.roomId, query: request.input.query, limit: request.input.limit }); break;
      case "context.read": value = await this.deps.context.read({ roomId: binding.roomId, eventIds: request.input.eventIds, limit: 50 }); break;
      case "git.status": value = await this.deps.git.status({ repositoryRootRealpath: binding.repositoryRootRealpath, worktreePathRealpath: binding.worktreePathRealpath }); break;
      case "git.diff": {
        this.assertOwned(binding, request.input.fromOid);
        if (request.input.toOid) this.assertOwned(binding, request.input.toOid);
        value = await this.deps.git.diff({ repositoryRootRealpath: binding.repositoryRootRealpath, fromOid: request.input.fromOid, toOid: request.input.toOid, pathspec: request.input.pathspec });
        break;
      }
      case "git.show": this.assertOwned(binding, request.input.checkpointOid); value = await this.deps.git.show({ repositoryRootRealpath: binding.repositoryRootRealpath, oid: request.input.checkpointOid, path: request.input.path }); break;
      case "git.log": this.assertOwned(binding, request.input.startOid); value = await this.deps.git.log({ repositoryRootRealpath: binding.repositoryRootRealpath, startOid: request.input.startOid, maxCount: request.input.maxCount }); break;
      default: throw new Error(`Unknown read-only tool: ${(request as { name: string }).name}`);
    }
    const encoded = JSON.stringify(value);
    const truncated = Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES;
    return { content: truncated ? Buffer.from(encoded).subarray(0, MAX_RESULT_BYTES).toString("utf8") : encoded, truncated };
  }

  private assertOwned(binding: ReadOnlyToolBinding, oid: string): void {
    if (oid !== binding.startOid && !binding.checkpointOids.has(oid)) throw new Error(`Checkpoint is not owned by task ${binding.taskId}`);
  }
}
```

Define `ContextReadRepository.search({ roomId, query, limit })` and `read({ roomId, eventIds, limit })` in `context-repository.ts`; both return canonical room events and never raw SQLite handles. `ToolBridge` validates `ReadOnlyToolRequestSchema`, resolves the immutable run binding server-side, correlates `callId`, and returns only bounded JSON content.

- [ ] **Step 4: Run read-only tool and Git argv tests**

Run: `pnpm exec vitest run tests/unit/tools/read-only-tool-service.test.ts tests/integration/providers/read-only-git-tools.test.ts`

Expected: exit 0; all six tools, cross-room reads, arbitrary OIDs, path traversal, symlink pathspecs, Git mutation names, output truncation, and argv-only Git calls PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/tools/read-only-tool-service.ts src/worker/tools/tool-bridge.ts src/worker/tools/tool-schemas.ts src/worker/context/context-repository.ts tests/unit/tools/read-only-tool-service.test.ts tests/integration/providers/read-only-git-tools.test.ts
git commit -m "feat: expose bounded read-only agent tools"
```

### Task 8: Add the Provider-Runner JSONL Protocol and Raw-Event-First Coordinator

**Files:**
- Create: `src/shared/contracts/provider-runner.ts`
- Create: `src/provider-runner/jsonl-channel.ts`
- Create: `src/provider-runner/runtime.ts`
- Create: `src/provider-runner/index.ts`
- Create: `src/worker/providers/provider-run-coordinator.ts`
- Modify: `electron.vite.config.ts`
- Modify: `tsconfig.node.json`
- Modify: `src/worker/storage/provider-repository.ts`
- Create: `tests/unit/providers/provider-runner-protocol.test.ts`
- Create: `tests/integration/providers/provider-run-coordinator.test.ts`

**Interfaces:**
- Consumes: `TaskProviderPort` request/handle types, `ProviderRepository.appendRawEvent`, provider pure normalizers, and `ToolBridge`.
- Produces: `ProviderRunnerCommand`, `ProviderRunnerMessage`, `ProviderRunnerTransport`, `ProviderRunnerRuntime`, and `ProviderRunCoordinator` that persists raw sequence N before emitting any normalized sequence N event.

- [ ] **Step 1: Write failing protocol-size and persistence-order tests**

```ts
// tests/integration/providers/provider-run-coordinator.test.ts
import { describe, expect, it, vi } from "vitest";
import { ProviderRunCoordinator } from "../../../src/worker/providers/provider-run-coordinator";

describe("ProviderRunCoordinator", () => {
  it("commits the raw event before normalization or timeline publication", async () => {
    const order: string[] = [];
    const repository = {
      appendRawEvent: vi.fn(async () => { order.push("raw"); }),
      saveSession: vi.fn(async () => { order.push("session"); }),
    };
    const normalizer = vi.fn(() => {
      order.push("normalize");
      return [{
        type: "session.started",
        runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
        provider: "codex",
        providerSeq: 0,
        occurredAt: "2026-07-21T10:00:00.000Z",
        sessionId: "thread-1",
      }];
    });
    const publish = vi.fn(async () => { order.push("publish"); });
    const coordinator = new ProviderRunCoordinator({ repository: repository as never, normalizer, publish, toolBridge: {} as never });
    await coordinator.acceptRunnerMessage({
      type: "provider.raw",
      runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      providerSeq: 0,
      receivedAt: "2026-07-21T10:00:00.000Z",
      payload: { type: "thread.started", thread_id: "thread-1" },
    });
    expect(order).toEqual(["raw", "normalize", "session", "publish"]);
  });
});
```

```ts
// tests/unit/providers/provider-runner-protocol.test.ts
import { describe, expect, it } from "vitest";
import { ProviderRunnerCommandSchema, ProviderRunnerMessageSchema } from "../../../src/shared/contracts/provider-runner";

describe("provider runner protocol", () => {
  it("requires run IDs and canonical executable paths", () => {
    expect(() => ProviderRunnerCommandSchema.parse({ type: "run.start", provider: "codex" })).toThrow();
  });

  it("rejects oversized JSONL before parsing", async () => {
    const { decodeJsonLine } = await import("../../../src/provider-runner/jsonl-channel");
    expect(() => decodeJsonLine("x".repeat(1_048_577), ProviderRunnerMessageSchema)).toThrow("Provider runner line exceeds 1048576 bytes");
  });
});
```

- [ ] **Step 2: Run tests and verify protocol/coordinator modules are absent**

Run: `pnpm exec vitest run tests/unit/providers/provider-runner-protocol.test.ts tests/integration/providers/provider-run-coordinator.test.ts`

Expected: FAIL with `Cannot find module '../../../src/shared/contracts/provider-runner'`.

- [ ] **Step 3: Implement bounded envelopes and a runtime with explicit abort**

```ts
// src/shared/contracts/provider-runner.ts
import { z } from "zod";
import { ProviderIdSchema, ProviderRunPayloadSchema } from "./provider";

const RunId = z.string().uuid();
export const ProviderRunnerCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.start"), runId: RunId, provider: ProviderIdSchema, executableRealpath: z.string().startsWith("/"), codexConfigLockRealpath: z.string().startsWith("/").nullable(), request: ProviderRunPayloadSchema }).strict(),
  z.object({ type: z.literal("run.resume"), runId: RunId, provider: ProviderIdSchema, executableRealpath: z.string().startsWith("/"), codexConfigLockRealpath: z.string().startsWith("/").nullable(), providerSessionId: z.string().min(1), request: ProviderRunPayloadSchema }).strict(),
  z.object({ type: z.literal("run.cancel"), runId: RunId, reason: z.enum(["user", "quit", "timeout"]), deadlineAt: z.string().datetime() }).strict(),
  z.object({ type: z.literal("tool.result"), runId: RunId, callId: z.string().uuid(), result: z.object({ content: z.string(), truncated: z.boolean() }).strict() }).strict(),
]);

export const ProviderRunnerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runner.ready"), runId: RunId, pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("provider.raw"), runId: RunId, providerSeq: z.number().int().nonnegative(), receivedAt: z.string().datetime(), payload: z.unknown() }).strict(),
  z.object({ type: z.literal("tool.call"), runId: RunId, callId: z.string().uuid(), request: z.unknown() }).strict(),
  z.object({ type: z.literal("run.completed"), runId: RunId }).strict(),
  z.object({ type: z.literal("run.failed"), runId: RunId, code: z.string().min(1), message: z.string().min(1) }).strict(),
  z.object({ type: z.literal("run.cancelled"), runId: RunId }).strict(),
]);
export type ProviderRunnerCommand = z.infer<typeof ProviderRunnerCommandSchema>;
export type ProviderRunnerMessage = z.infer<typeof ProviderRunnerMessageSchema>;
```

```ts
// src/provider-runner/runtime.ts
import type { ProviderRunnerCommand, ProviderRunnerMessage } from "../shared/contracts/provider-runner";

export interface ProviderRunnerRuntime {
  start(command: Extract<ProviderRunnerCommand, { type: "run.start" | "run.resume" }>, emit: (message: ProviderRunnerMessage) => Promise<void>): Promise<void>;
  cancel(reason: "user" | "quit" | "timeout"): Promise<void>;
  close(): Promise<void>;
}
```

Add a schema refinement requiring a non-null canonical `codexConfigLockRealpath` for Codex and exactly `null` for Claude. `jsonl-channel.ts` reads UTF-8 one line at a time, caps each line at exactly 1,048,576 bytes, parses through the supplied Zod schema, and writes one serialized envelope per line with backpressure. `index.ts` requires `--branchestra-run-id <uuid>` and `--branchestra-provider-executable-realpath <canonical-absolute-path>`, verifies that the first start/resume command contains the same Provider executable, rechecks the Codex lock path/hash/version through the shared validator before lazy import, sends `runner.ready`, lazily imports only `claude-runtime` or `codex-runtime` after a valid start command, and routes correlated tool results. It exits nonzero on malformed envelopes, an executable mismatch, or a missing/mismatched lock.

- [ ] **Step 4: Implement raw-first coordination and idempotent provider sequence storage**

```ts
// core of src/worker/providers/provider-run-coordinator.ts
async acceptRunnerMessage(message: ProviderRunnerMessage): Promise<void> {
  if (message.type === "provider.raw") {
    await this.deps.repository.appendRawEvent({
      id: this.deps.ids.next(),
      runId: message.runId,
      providerSeq: message.providerSeq,
      payload: message.payload,
      receivedAt: message.receivedAt,
    });
    const events = this.deps.normalizer(message.payload, {
      runId: message.runId,
      providerSeq: message.providerSeq,
      occurredAt: message.receivedAt,
    });
    for (const event of events) {
      if (event.type === "session.started") await this.deps.repository.saveSessionFromEvent(event);
      await this.deps.publish(event);
    }
    return;
  }
  if (message.type === "tool.call") {
    const result = await this.deps.toolBridge.handle(message.runId, message.callId, message.request);
    await this.deps.transport.send({ type: "tool.result", runId: message.runId, callId: message.callId, result });
    return;
  }
  await this.deps.handleTerminalMessage(message);
}
```

The repository uses `UNIQUE(run_id, provider_seq)` so a replayed runner event is acknowledged without a second normalized timeline event. The coordinator implements `TaskProviderPort` handles but delegates process creation and group cancellation to Task 9's supervisor.

- [ ] **Step 5: Add a stable externalized Provider-runner build entry**

Extend the existing Main Rollup input without changing the `index` or `worker` output names. `externalizeDepsPlugin()` remains active so both SDK packages stay runtime dependencies and their optional executables can be excluded and scanned during packaging.

```ts
// electron.vite.config.ts (main section)
main: {
  plugins: [externalizeDepsPlugin()],
  build: {
    rollupOptions: {
      input: {
        index: resolve("src/main/index.ts"),
        worker: resolve("src/worker/index.ts"),
        "provider-runner": resolve("src/provider-runner/index.ts"),
      },
    },
  },
},
```

Production composition passes the canonical `out/main/provider-runner.js` path to `ProviderProcessSupervisor`; neither Renderer nor a Provider event can override it.

Extend `tsconfig.node.json#include` with `src/provider-runner/**/*.ts`; the runner is a strict Node/Electron-as-Node entry and must be covered by `pnpm typecheck`, even when a particular file is not imported by a unit-test root.

- [ ] **Step 6: Run protocol, raw-order, duplicate-sequence, build-output, and type tests**

Run: `pnpm exec vitest run tests/unit/providers/provider-runner-protocol.test.ts tests/integration/providers/provider-run-coordinator.test.ts && pnpm typecheck && pnpm build && test -f out/main/provider-runner.js`

Expected: exit 0; bounded framing, malformed payload, raw-before-normalize, session persistence order, duplicate sequence, tool correlation, type checks, and the stable externalized runner artifact PASS.

- [ ] **Step 7: Commit**

```bash
git add electron.vite.config.ts tsconfig.node.json src/shared/contracts/provider-runner.ts src/provider-runner/jsonl-channel.ts src/provider-runner/runtime.ts src/provider-runner/index.ts src/worker/providers/provider-run-coordinator.ts src/worker/storage/provider-repository.ts tests/unit/providers/provider-runner-protocol.test.ts tests/integration/providers/provider-run-coordinator.test.ts
git commit -m "feat: coordinate isolated provider runners"
```

### Task 9: Supervise a Dedicated Detached Provider Process Group

**Files:**
- Create: `src/worker/process/process-identity.ts`
- Create: `src/worker/process/provider-process-supervisor.ts`
- Modify: `src/worker/operations/operation-journal.ts`
- Modify: `src/worker/providers/provider-run-coordinator.ts`
- Create: `tests/fixtures/process/provider-runner-fixture.mjs`
- Create: `tests/fixtures/process/stubborn-grandchild.mjs`
- Create: `tests/unit/process/process-identity.test.ts`
- Create: `tests/integration/providers/provider-process-supervisor.test.ts`

**Interfaces:**
- Consumes: Task 8 runner envelopes, Milestone 1 `execFileNoShell`, Milestone 2's single `operation_journal`, the current worker generation UUID, Node `spawn`, and POSIX group signaling.
- Produces: `ProviderProcessIdentity`, `ProcessIdentityProbe.read/verify`, `ProviderProcessSupervisor.spawn/cancel/reconcileOrphan`, and journal methods for provider-process intent, identity observation, signal observation, and completion.

- [ ] **Step 1: Write failing detached-group cancellation and identity tests**

```ts
// tests/integration/providers/provider-process-supervisor.test.ts
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderProcessSupervisor } from "../../../src/worker/process/provider-process-supervisor";
import { createProcessSupervisorHarness } from "../../helpers/process-supervisor-harness";

describe.runIf(process.platform === "darwin")("ProviderProcessSupervisor", () => {
  it("aborts, TERM-signals, then KILL-signals a verified runner group", async () => {
    const harness = await createProcessSupervisorHarness();
    const supervisor = new ProviderProcessSupervisor(harness.dependencies({
      abortGraceMs: 100,
      termGraceMs: 100,
    }));
    const handle = await supervisor.spawn({
      runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      workerGeneration: "119f842d-e19a-7cc1-9d73-4d287bf40558",
      runnerEntryRealpath: resolve("tests/fixtures/process/provider-runner-fixture.mjs"),
      providerExecutableRealpath: "/usr/bin/true",
      env: { HOME: "/tmp", PATH: "/usr/bin:/bin" },
    });
    const grandchildPid = await handle.waitForFixtureGrandchild();
    await supervisor.cancel(handle.runId, "user");
    expect(() => process.kill(handle.pgid, 0)).toThrow();
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    expect(harness.journal.signals(handle.runId)).toEqual(["abort", "SIGTERM", "SIGKILL"]);
  });

  it("refuses to signal a reused or mismatched group identity", async () => {
    const harness = await createProcessSupervisorHarness({ forceIdentityMismatch: true });
    const supervisor = new ProviderProcessSupervisor(harness.dependencies({ abortGraceMs: 10, termGraceMs: 10 }));
    const handle = await supervisor.spawnFixture();
    await expect(supervisor.cancel(handle.runId, "timeout")).rejects.toThrow("Provider process identity no longer matches journal");
    expect(harness.signalCalls()).toEqual([]);
    await harness.stopFixtureDirectly(handle);
  });
});
```

```ts
// tests/unit/process/process-identity.test.ts
import { describe, expect, it } from "vitest";
import { identitiesMatch } from "../../../src/worker/process/process-identity";

describe("provider process identity", () => {
  const expected = {
    runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
    pid: 4100,
    pgid: 4100,
    runnerExecutableRealpath: "/usr/local/bin/node",
    providerExecutableRealpath: "/opt/homebrew/bin/codex",
    startToken: "Tue Jul 21 10:00:00 2026",
    workerGeneration: "119f842d-e19a-7cc1-9d73-4d287bf40558",
  };

  it("requires run ID, generation, executable, group leader, and start token", () => {
    expect(identitiesMatch(expected, expected)).toBe(true);
    expect(identitiesMatch(expected, { ...expected, startToken: "Tue Jul 21 10:00:01 2026" })).toBe(false);
    expect(identitiesMatch(expected, { ...expected, runId: "219f842d-e19a-7cc1-9d73-4d287bf40558" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and verify the supervisor is absent**

Run: `pnpm exec vitest run tests/unit/process/process-identity.test.ts tests/integration/providers/provider-process-supervisor.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/process/provider-process-supervisor'`.

- [ ] **Step 3: Add exact identity and journal records around detached spawn**

```ts
// src/worker/process/process-identity.ts
export interface ProviderProcessIdentity {
  runId: string;
  pid: number;
  pgid: number;
  runnerExecutableRealpath: string;
  providerExecutableRealpath: string;
  startToken: string;
  workerGeneration: string;
}

export function identitiesMatch(expected: ProviderProcessIdentity, observed: ProviderProcessIdentity): boolean {
  return expected.runId === observed.runId
    && expected.pid === observed.pid
    && expected.pgid === observed.pgid
    && expected.pid === expected.pgid
    && expected.runnerExecutableRealpath === observed.runnerExecutableRealpath
    && expected.providerExecutableRealpath === observed.providerExecutableRealpath
    && expected.startToken === observed.startToken
    && expected.workerGeneration === observed.workerGeneration;
}
```

`ProcessIdentityProbe.read(pid, expectedRunId, providerExecutableRealpath, workerGeneration)` calls `/bin/ps` through `execFileNoShell` with `-o pid=,pgid=,lstart=,command= -p <pid>`, requires `pid === pgid`, canonicalizes `process.execPath`, and requires the command argv to contain the exact `--branchestra-run-id <uuid>` and `--branchestra-provider-executable-realpath <canonical-path>` pairs. It never treats a bare PID as identity.

Before `spawn`, append a `provider_process` intent to the existing operation journal with run ID, generation, runner realpath, and provider executable realpath. Spawn exactly:

```ts
const child = spawn(process.execPath, [
  input.runnerEntryRealpath,
  "--branchestra-run-id",
  input.runId,
  "--branchestra-provider-executable-realpath",
  input.providerExecutableRealpath,
], {
  cwd: dirname(input.runnerEntryRealpath),
  detached: true,
  env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
```

`process.execPath` is the Electron/packaged Branchestra executable, so `ELECTRON_RUN_AS_NODE=1` is required to execute the compiled JavaScript entry as Node. This variable belongs only to the runner process environment; the adapter still passes its separately constructed Claude/Codex allowlist to the SDK child. The release configuration must keep Electron's `RunAsNode` fuse enabled and the packaged mock-runner smoke test must exercise this exact launch path.

Read and verify the new group leader identity, then update that same journal row's `provider_run_id` and `process_identity_json`. If identity observation fails, terminate only the still-referenced direct child, call the existing `needsAttention`, and return no handle.

- [ ] **Step 4: Implement Abort → TERM → KILL with verification before each group signal**

```ts
// cancellation core in src/worker/process/provider-process-supervisor.ts
async cancel(runId: string, reason: CancelReason): Promise<void> {
  const active = this.requireActive(runId);
  await active.transport.send({
    type: "run.cancel",
    runId,
    reason,
    deadlineAt: new Date(Date.parse(this.clock.now()) + this.config.abortGraceMs).toISOString(),
  });
  await this.journal.recordProviderSignal(runId, "abort", this.clock.now());
  if (await this.waitForExit(active, this.config.abortGraceMs)) return this.complete(active);

  await this.verifyCurrentIdentity(active.identity);
  process.kill(-active.identity.pgid, "SIGTERM");
  await this.journal.recordProviderSignal(runId, "SIGTERM", this.clock.now());
  if (await this.waitForExit(active, this.config.termGraceMs)) return this.complete(active);

  await this.verifyCurrentIdentity(active.identity);
  process.kill(-active.identity.pgid, "SIGKILL");
  await this.journal.recordProviderSignal(runId, "SIGKILL", this.clock.now());
  await this.waitForExit(active, this.config.killWaitMs);
  await this.complete(active);
}
```

Production typed defaults are `abortGraceMs: 3_000`, `termGraceMs: 2_000`, and `killWaitMs: 1_000`. `reconcileOrphan` scans unfinished `provider_process` rows and signals a group only after the same full identity verification. The fixture runner spawns a detached-inherited grandchild that ignores TERM so the test proves KILL reaches grandchildren.

- [ ] **Step 5: Run supervisor, orphan, worker-crash, and identity tests**

Run: `pnpm exec vitest run tests/unit/process/process-identity.test.ts tests/integration/providers/provider-process-supervisor.test.ts`

Expected: exit 0; detached group leadership, abort-first order, TERM graceful exit, KILL escalation, grandchild cleanup, reused PID rejection, generation mismatch, and orphan reconciliation PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/process/process-identity.ts src/worker/process/provider-process-supervisor.ts src/worker/operations/operation-journal.ts src/worker/providers/provider-run-coordinator.ts tests/fixtures/process/provider-runner-fixture.mjs tests/fixtures/process/stubborn-grandchild.mjs tests/helpers/process-supervisor-harness.ts tests/unit/process/process-identity.test.ts tests/integration/providers/provider-process-supervisor.test.ts
git commit -m "feat: supervise provider process groups"
```

### Task 10: Implement the Claude Agent SDK Runtime and Event Contract

**Files:**
- Create: `src/provider-runner/sdk-factories.ts`
- Create: `src/provider-runner/claude-runtime.ts`
- Create: `src/worker/providers/normalization/claude-event.ts`
- Create: `tests/fixtures/providers/claude/success.jsonl`
- Create: `tests/fixtures/providers/claude/unknown-fields.jsonl`
- Create: `tests/fixtures/providers/claude/missing-session.jsonl`
- Create: `tests/unit/providers/claude-runtime.test.ts`
- Create: `tests/unit/providers/claude-normalization.test.ts`

**Interfaces:**
- Consumes: `ProviderRunnerRuntime`, `ApprovedRunCapabilities`, `ToolBridge` client, external executable realpath, clean Claude environment, and injected `ClaudeSdkFactory`.
- Produces: `createClaudeRuntime(deps)`, `loadClaudeSdkFactory()`, `CLAUDE_CAPABILITIES`, and `normalizeClaudeEvent(raw, run): ProviderEvent[]`.

- [ ] **Step 1: Write failing external-path, sandbox, resume, cancellation, and fixture tests**

```ts
// tests/unit/providers/claude-runtime.test.ts
import { describe, expect, it, vi } from "vitest";
import { createClaudeRuntime } from "../../../src/provider-runner/claude-runtime";
import { claudeRunCommand, createClaudeSdkDouble } from "../../helpers/provider-sdk-doubles";

describe("Claude provider runtime", () => {
  it("passes the verified external path and restrictive options to query", async () => {
    const sdk = createClaudeSdkDouble();
    const runtime = createClaudeRuntime({ sdk, toolClient: { call: vi.fn() }, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(claudeRunCommand({ providerSessionId: "claude-session-1" }), vi.fn());
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude",
        cwd: "/worktrees/task-1/lead",
        permissionMode: "default",
        strictMcpConfig: true,
        settingSources: [],
        resume: "claude-session-1",
        allowDangerouslySkipPermissions: false,
        sandbox: expect.objectContaining({
          enabled: true,
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
        }),
      }),
    }));
  });

  it("aborts and closes the query", async () => {
    const sdk = createClaudeSdkDouble({ keepOpen: true });
    const runtime = createClaudeRuntime({ sdk, toolClient: { call: vi.fn() }, now: () => new Date() });
    const running = runtime.start(claudeRunCommand({ providerSessionId: null }), vi.fn());
    await runtime.cancel("user");
    expect(sdk.abortController.signal.aborted).toBe(true);
    expect(sdk.queryHandle.close).toHaveBeenCalledOnce();
    await running;
  });
});
```

```ts
// tests/unit/providers/claude-normalization.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeClaudeEvent } from "../../../src/worker/providers/normalization/claude-event";

const run = { runId: "019f842d-e19a-7cc1-9d73-4d287bf40558", providerSeq: 0, occurredAt: "2026-07-21T10:00:00.000Z" };

describe("Claude event contract", () => {
  it("captures session_id from system init and result fixtures", () => {
    const events = readFileSync("tests/fixtures/providers/claude/success.jsonl", "utf8").trim().split("\n").flatMap((line) => normalizeClaudeEvent(JSON.parse(line), run));
    expect(events.filter((event) => event.type === "session.started").map((event) => event.sessionId)).toEqual(["claude-session-1", "claude-session-1"]);
  });

  it("allows unknown fields but rejects missing critical session semantics", () => {
    const withUnknown = JSON.parse(readFileSync("tests/fixtures/providers/claude/unknown-fields.jsonl", "utf8"));
    expect(normalizeClaudeEvent(withUnknown, run).length).toBeGreaterThan(0);
    const missing = JSON.parse(readFileSync("tests/fixtures/providers/claude/missing-session.jsonl", "utf8"));
    expect(() => normalizeClaudeEvent(missing, run)).toThrow("Claude result is missing session_id");
  });
});
```

- [ ] **Step 2: Run tests and verify the Claude runtime/normalizer are absent**

Run: `pnpm exec vitest run tests/unit/providers/claude-runtime.test.ts tests/unit/providers/claude-normalization.test.ts`

Expected: FAIL with `Cannot find module '../../../src/provider-runner/claude-runtime'`.

- [ ] **Step 3: Implement the only Claude SDK factory and exact query options**

```ts
// Claude portion of src/provider-runner/sdk-factories.ts
export type ClaudeSdkModule = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  "query" | "tool" | "createSdkMcpServer"
>;

export interface ClaudeSdkFactory {
  load(): Promise<ClaudeSdkModule>;
}

export const loadClaudeSdkFactory = (): ClaudeSdkFactory => ({
  load: () => import("@anthropic-ai/claude-agent-sdk"),
});
```

The constructor for `createClaudeRuntime` requires `executableRealpath`; there is no overload or default. Build its query as follows:

```ts
const abortController = new AbortController();
const queryHandle = sdk.query({
  prompt: request.instruction,
  options: {
    abortController,
    pathToClaudeCodeExecutable: request.executableRealpath,
    cwd: request.worktreePath,
    env: request.environment,
    resume: request.providerSessionId ?? undefined,
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    allowedTools: [
      "mcp__branchestra__context_search",
      "mcp__branchestra__context_read",
      "mcp__branchestra__git_status",
      "mcp__branchestra__git_diff",
      "mcp__branchestra__git_show",
      "mcp__branchestra__git_log",
    ],
    disallowedTools: [
      "Agent",
      "Task",
      "EnterWorktree",
      "ExitWorktree",
      "WebFetch",
      "WebSearch",
      "Bash(git *)",
    ],
    canUseTool: (toolName, input) => permissionGate.decide(toolName, input),
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: [request.approvedCapabilities.workspaceRootRealpath],
        denyWrite: request.deniedWriteRoots,
      },
      network: {
        allowedDomains: request.approvedCapabilities.toolNetwork ? ["*"] : [],
        deniedDomains: request.approvedCapabilities.toolNetwork ? [] : ["*"],
        allowLocalBinding: false,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
      },
    },
    mcpServers: { branchestra: readOnlyMcpServer },
    strictMcpConfig: true,
    settingSources: [],
    additionalDirectories: [],
    persistSession: true,
    includePartialMessages: true,
  },
});
```

Create the six MCP tools with `tool()` and `createSdkMcpServer()`, mark each `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`, and forward through the correlated `ToolBridge` client. `permissionGate` allows only operations already covered by `ApprovedRunCapabilities`; otherwise it emits an app `approval.required` raw event and returns `{ behavior: "deny", message: "Outside Branchestra approval scope", interrupt: true }`. It never waits for or creates a Provider-native user approval.

- [ ] **Step 4: Implement pure event normalization and SDK abort/close**

`normalizeClaudeEvent` accepts `.passthrough()` Zod schemas for `system:init`, assistant content/tool blocks, permission denial, and `result`; it throws when init/result lacks `session_id`, maps partial text only when the fixture supplies a stable delta event, redacts tool inputs to summaries, and maps usage fields without requiring cost. The runtime emits every SDK message unchanged as `provider.raw`; on cancellation it calls `abortController.abort()` then `queryHandle.close()` exactly once.

Set capabilities exactly:

```ts
export const CLAUDE_CAPABILITIES = {
  interactiveApproval: true,
  protocolInterrupt: false,
  processAbort: true,
  textDeltaStreaming: true,
  itemEventStreaming: true,
  sessionResume: true,
  workspaceWriteSandbox: true,
  toolNetworkControl: true,
  contextTools: "mcp",
} as const;
```

- [ ] **Step 5: Run Claude runtime, fixture, permission, and external-path tests**

Run: `pnpm exec vitest run tests/unit/providers/claude-runtime.test.ts tests/unit/providers/claude-normalization.test.ts tests/unit/providers/sdk-version-policy.test.ts`

Expected: exit 0; external path, default permissions, callback denial, sandbox roots, no settings sources, strict MCP, init/result session IDs, unknown fields, partial stream, AbortController, `close()`, and forbidden platform imports PASS.

- [ ] **Step 6: Commit**

```bash
git add src/provider-runner/sdk-factories.ts src/provider-runner/claude-runtime.ts src/worker/providers/normalization/claude-event.ts tests/fixtures/providers/claude/success.jsonl tests/fixtures/providers/claude/unknown-fields.jsonl tests/fixtures/providers/claude/missing-session.jsonl tests/helpers/provider-sdk-doubles.ts tests/unit/providers/claude-runtime.test.ts tests/unit/providers/claude-normalization.test.ts
git commit -m "feat: add external Claude adapter runtime"
```

### Task 11: Implement the Codex SDK Runtime and Item-Level Event Contract

**Files:**
- Modify: `src/provider-runner/sdk-factories.ts`
- Create: `src/provider-runner/codex-runtime.ts`
- Create: `src/worker/providers/normalization/codex-event.ts`
- Create: `tests/fixtures/providers/codex/success.jsonl`
- Create: `tests/fixtures/providers/codex/unknown-fields.jsonl`
- Create: `tests/fixtures/providers/codex/permission-failure.jsonl`
- Create: `tests/unit/providers/codex-runtime.test.ts`
- Create: `tests/unit/providers/codex-normalization.test.ts`
- Create: `tests/integration/providers/codex-config-isolation.test.ts`

**Interfaces:**
- Consumes: `ProviderRunnerRuntime`, external Codex realpath, clean Codex environment, branded authoritative config-lock realpath, `ContextBundle.payload.injectedReadOnlySnapshot`, and injected `CodexSdkFactory`.
- Produces: `createCodexRuntime(deps)`, `CODEX_CAPABILITIES`, and `normalizeCodexEvent(raw, run): ProviderEvent[]` with item snapshots rather than assumed token deltas.

- [ ] **Step 1: Write failing constructor/thread/resume/permission tests**

```ts
// tests/unit/providers/codex-runtime.test.ts
import { describe, expect, it, vi } from "vitest";
import { createCodexRuntime } from "../../../src/provider-runner/codex-runtime";
import { codexRunCommand, createCodexSdkDouble } from "../../helpers/provider-sdk-doubles";

describe("Codex provider runtime", () => {
  it("uses only external path and replacement env constructor options", async () => {
    const sdk = createCodexSdkDouble();
    const runtime = createCodexRuntime({ sdk, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(codexRunCommand({ providerSessionId: null }), vi.fn());
    expect(sdk.constructorOptions()).toEqual({
      codexPathOverride: "/opt/homebrew/bin/codex",
      env: { HOME: "/Users/tester", PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      config: {
        debug: {
          config_lockfile: {
            load_path: "/Applications/Branchestra.app/Contents/Resources/codex/0.144.6/subscription.config.lock.toml",
            allow_codex_version_mismatch: false,
          },
        },
      },
    });
    expect(sdk.startThread).toHaveBeenCalledWith({
      workingDirectory: "/worktrees/task-1/collaborator",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      additionalDirectories: [],
    });
    expect(sdk.runStreamed).toHaveBeenCalledWith(expect.stringContaining("READ-ONLY BRANCHESTRA SNAPSHOT"), { signal: expect.any(AbortSignal) });
  });

  it("uses resumeThread and ends permission failure for app-level approval", async () => {
    const sdk = createCodexSdkDouble({ fixture: "permission-failure" });
    const emit = vi.fn();
    const runtime = createCodexRuntime({ sdk, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(codexRunCommand({ providerSessionId: "thread-1" }), emit);
    expect(sdk.resumeThread).toHaveBeenCalledWith("thread-1", expect.any(Object));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "provider.raw", payload: expect.objectContaining({ type: "turn.failed" }) }));
    expect(sdk.runStreamed).toHaveBeenCalledTimes(1);
  });

  it("enables shell-tool network only when the durable receipt enables it", async () => {
    const sdk = createCodexSdkDouble();
    const runtime = createCodexRuntime({ sdk, now: () => new Date("2026-07-21T10:00:00.000Z") });
    await runtime.start(codexRunCommand({ providerSessionId: null, toolNetwork: true }), vi.fn());
    expect(sdk.startThread).toHaveBeenCalledWith(expect.objectContaining({
      networkAccessEnabled: true,
      webSearchMode: "disabled",
      webSearchEnabled: false,
    }));
  });
});
```

- [ ] **Step 2: Run tests and verify the Codex runtime/normalizer are absent**

Run: `pnpm exec vitest run tests/unit/providers/codex-runtime.test.ts tests/unit/providers/codex-normalization.test.ts tests/integration/providers/codex-config-isolation.test.ts`

Expected: FAIL with `Cannot find module '../../../src/provider-runner/codex-runtime'`.

- [ ] **Step 3: Add the required-path Codex SDK factory and thread options**

```ts
// Codex portion of src/provider-runner/sdk-factories.ts
export interface CodexSdkFactory {
  create(input: {
    codexPathOverride: string;
    env: Record<string, string>;
    codexConfigLockRealpath: string;
  }): CodexClientPort;
}

export async function loadCodexSdkFactory(): Promise<CodexSdkFactory> {
  const { Codex } = await import("@openai/codex-sdk");
  return {
    create: (input) => new Codex({
      codexPathOverride: input.codexPathOverride,
      env: input.env,
      config: {
        debug: {
          config_lockfile: {
            load_path: input.codexConfigLockRealpath,
            allow_codex_version_mismatch: false,
          },
        },
      },
    }),
  };
}
```

`CodexClientPort` exposes only `startThread(options)` and `resumeThread(id, options)`; `CodexThreadPort` exposes `runStreamed(input, { signal })`. The factory input accepts the branded lock realpath, never a caller-authored config object. The implementation contains exactly the two literal config-lock keys above; source-guard tests reject `apiKey`, `baseUrl`, `openai_base_url`, `chatgpt_base_url`, `model_provider`, `model_providers`, or any second `config` source in application code. Construct thread options exactly as asserted above, setting `networkAccessEnabled: request.approvedCapabilities.toolNetwork` while keeping both web-search fields disabled. Prepend the serialized context bundle and `injectedReadOnlySnapshot` to the instruction because this SDK combination has no registered Branchestra tool channel.

`codex-config-isolation.test.ts` launches a fixture external CLI through the real SDK spawn path and supplies both a malicious user config and a malicious worktree `.codex/config.toml`; each selects a canary provider and loopback base URL. Assert the captured argv contains only the reviewed lock override and the fixture canary receives zero connections. The test must fail if `load_path` is removed, if version mismatch is allowed, or if the SDK factory accepts arbitrary config. This is deterministic construction/precedence coverage; Task 14 is the required semantic proof with the exact real CLI, authoritative lock replay, subscription transport, and both release architectures.

- [ ] **Step 4: Normalize thread/item/usage/failure events without promising deltas**

```ts
export const CODEX_CAPABILITIES = {
  interactiveApproval: false,
  protocolInterrupt: false,
  processAbort: true,
  textDeltaStreaming: false,
  itemEventStreaming: true,
  sessionResume: true,
  workspaceWriteSandbox: true,
  toolNetworkControl: true,
  contextTools: "injected",
} as const;
```

`normalizeCodexEvent` persists `thread.started.thread_id` as `session.started`, maps `item.started`, `item.updated`, and `item.completed` to full `item.snapshot` values, maps `turn.completed.usage`, and never synthesizes `assistant.delta`. When a `turn.failed` fixture reports sandbox/permission denial, emit `approval.required { resumeStrategy: "next_run" }` followed by `run.failed { code: "permission_denied" }`. The runtime stops that turn; it does not wait for approval or retry in place. Task 12 starts a subsequent app run after durable approval.

- [ ] **Step 5: Run Codex runtime, fixture, item, abort, and constructor tests**

Run: `pnpm exec vitest run tests/unit/providers/codex-runtime.test.ts tests/unit/providers/codex-normalization.test.ts tests/unit/providers/sdk-version-policy.test.ts tests/integration/providers/codex-config-isolation.test.ts`

Expected: exit 0; exact constructor keys, replacement env, authoritative config lock, malicious home/project config isolation, start/resume thread, worktree sandbox, never approval, network/web off, item snapshots, immediate thread ID, permission failure, AbortSignal, no delta claim, and external-path source guard PASS.

- [ ] **Step 6: Commit**

```bash
git add src/provider-runner/sdk-factories.ts src/provider-runner/codex-runtime.ts src/worker/providers/normalization/codex-event.ts tests/fixtures/providers/codex/success.jsonl tests/fixtures/providers/codex/unknown-fields.jsonl tests/fixtures/providers/codex/permission-failure.jsonl tests/helpers/provider-sdk-doubles.ts tests/unit/providers/codex-runtime.test.ts tests/unit/providers/codex-normalization.test.ts tests/integration/providers/codex-config-isolation.test.ts
git commit -m "feat: add external Codex adapter runtime"
```

### Task 12: Persist, Resume, and Recover Provider Sessions Safely

**Files:**
- Create: `src/worker/providers/provider-session-service.ts`
- Modify: `src/worker/storage/provider-repository.ts`
- Modify: `src/worker/tasks/recovery-coordinator.ts`
- Modify: `src/worker/tasks/provider-port.ts`
- Create: `tests/integration/providers/provider-session-service.test.ts`
- Modify: `tests/integration/tasks/task-recovery.test.ts`

**Interfaces:**
- Consumes: Task 4 `provider_sessions`, context bundles, latest checkpoint/diff/test state, Milestone 2 interrupted-task reconciliation, and `ProviderAdapter.startRun/resumeRun`.
- Produces: `ProviderSessionService.recordStarted`, `markInterrupted`, `resumeOrRecover`, `RecoveryBrief`, and a recovery result distinguishing `resumed_session` from `new_session_with_brief`.

- [ ] **Step 1: Write failing durable resume and fallback tests**

```ts
// tests/integration/providers/provider-session-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { createProviderSessionHarness } from "../../helpers/provider-session-harness";

describe("ProviderSessionService", () => {
  it("reopens SQLite and resumes the persisted Provider ID", async () => {
    const harness = await createProviderSessionHarness();
    await harness.service.recordStarted({
      runId: "019f842d-e19a-7cc1-9d73-4d287bf40558",
      provider: "codex",
      providerSessionId: "thread-1",
      contextHash: "a".repeat(64),
      providerSeq: 0,
    });
    await harness.reopen();
    const adapter = { resumeRun: vi.fn().mockResolvedValue(harness.handle("thread-1")), startRun: vi.fn() };
    const result = await harness.service.resumeOrRecover(harness.recoveryInput(adapter as never));
    expect(result.strategy).toBe("resumed_session");
    expect(adapter.resumeRun).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: "thread-1", contextHash: "a".repeat(64) }));
    expect(adapter.startRun).not.toHaveBeenCalled();
  });

  it("creates one new run with a recovery brief after resume rejection", async () => {
    const harness = await createProviderSessionHarness({ savedProviderSessionId: "claude-session-1" });
    const adapter = {
      resumeRun: vi.fn().mockRejectedValue(new Error("session unavailable")),
      startRun: vi.fn().mockResolvedValue(harness.handle("claude-session-2")),
    };
    const result = await harness.service.resumeOrRecover(harness.recoveryInput(adapter as never));
    expect(result.strategy).toBe("new_session_with_brief");
    expect(adapter.startRun).toHaveBeenCalledWith(expect.objectContaining({
      recoveryBrief: expect.stringContaining("Do not replay external side effects"),
    }));
    expect(adapter.startRun).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run recovery tests and verify the session service is absent**

Run: `pnpm exec vitest run tests/integration/providers/provider-session-service.test.ts tests/integration/tasks/task-recovery.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/providers/provider-session-service'`.

- [ ] **Step 3: Implement transactional session progress and explicit recovery briefs**

```ts
// src/worker/providers/provider-session-service.ts
export interface RecoveryBrief {
  interruptedRunId: string;
  providerSessionId: string;
  lastDurableProviderSeq: number;
  lastContextHash: string;
  latestCheckpointOid: string | null;
  diffSummary: string | null;
  testSummaries: readonly string[];
  instruction: "Do not replay external side effects. Continue from the durable state below.";
}

export class ProviderSessionService {
  constructor(private readonly deps: ProviderSessionDependencies) {}

  recordStarted(input: RecordSessionStartedInput): void {
    this.deps.repository.upsertSession({ ...input, resumeState: "active", updatedAt: this.deps.clock.now() });
  }

  async resumeOrRecover(input: ResumeOrRecoverInput): Promise<RecoveryResult> {
    const saved = this.deps.repository.requireResumableSession(input.interruptedRunId);
    try {
      const handle = await input.adapter.resumeRun(input.toResumeRequest(saved));
      return { strategy: "resumed_session", handle };
    } catch (error) {
      if (!this.deps.classifyResumeUnavailable(error)) throw error;
      const brief = await this.deps.buildRecoveryBrief(saved);
      const context = await this.deps.buildFreshContext(input, brief);
      const handle = await input.adapter.startRun(input.toRecoveryStartRequest(context, brief));
      this.deps.repository.markSessionReplaced(saved.runId, handle.runId, this.deps.clock.now());
      return { strategy: "new_session_with_brief", handle };
    }
  }
}
```

Advance `last_provider_seq` in the same transaction that stores each raw event. On process loss mark `interrupted`; after reconciliation and user confirmation mark `resumable`. Never auto-run recovery prompts during startup, never replay a half-finished tool or side-effect prompt, and retain the old session row as `replaced` when fallback succeeds.

- [ ] **Step 4: Run reopen, resume, fallback, duplicate, and no-auto-replay tests**

Run: `pnpm exec vitest run tests/integration/providers/provider-session-service.test.ts tests/integration/tasks/task-recovery.test.ts`

Expected: exit 0; Claude session, Codex thread, SQLite reopen, original context hash, fresh recovery context, one fallback start, user-confirmed resume, and no side-effect replay PASS.

- [ ] **Step 5: Commit**

```bash
git add src/worker/providers/provider-session-service.ts src/worker/storage/provider-repository.ts src/worker/tasks/recovery-coordinator.ts src/worker/tasks/provider-port.ts tests/helpers/provider-session-harness.ts tests/integration/providers/provider-session-service.test.ts tests/integration/tasks/task-recovery.test.ts
git commit -m "feat: resume durable provider sessions"
```

### Task 13: Register Real Adapters and Complete a Two-Agent Task Vertical Slice

**Files:**
- Create: `src/worker/providers/provider-registry.ts`
- Create: `src/worker/providers/runner-backed-adapter.ts`
- Modify: `src/worker/tasks/task-engine.ts`
- Modify: `src/worker/runtime.ts`
- Modify: `src/worker/protocol/worker-router.ts`
- Modify: `src/renderer/state/timeline-store.ts`
- Modify: `src/renderer/features/tasks/task-inspector.tsx`
- Create: `tests/helpers/private-provider-test-policy.ts`
- Create: `tests/integration/providers/dual-agent-provider-task.test.ts`
- Create: `tests/unit/providers/provider-registry.test.ts`

**Interfaces:**
- Consumes: all prior tasks, Milestone 2 task/approval/worktree/checkpoint/review/candidate services, and test-only fake SDK factories.
- Produces: production `createProviderRegistry()` using the literal public policy, test `createProviderRegistry({ policy, factories })`, two `RunnerBackedAdapter` instances, and a task engine that still depends only on `TaskProviderPort`.

- [ ] **Step 1: Write failing public-policy and real-adapter vertical tests**

```ts
// tests/unit/providers/provider-registry.test.ts
import { describe, expect, it } from "vitest";
import { createProviderRegistry } from "../../../src/worker/providers/provider-registry";

describe("production provider registry", () => {
  it("does not register public Claude subscription runs", () => {
    const registry = createProviderRegistry();
    expect(() => registry.requireRunnable("claude")).toThrow("Claude subscription runs are disabled by public release policy");
    expect(registry.requireRunnable("codex").provider).toBe("codex");
  });
});
```

```ts
// tests/integration/providers/dual-agent-provider-task.test.ts
import { describe, expect, it } from "vitest";
import { createDualAgentProviderHarness } from "../../helpers/dual-agent-provider-harness";

describe("two-Agent Provider Adapter vertical slice", () => {
  it("runs Claude lead, Codex reviewer, and Claude revision without MockProvider", async () => {
    const harness = await createDualAgentProviderHarness();
    const task = await harness.createApprovedTask({ mention: "@Claude", instruction: "Add and review the provider fixture" });
    await harness.runUntilCandidate(task.id);

    expect(harness.adaptersUsed()).toEqual(["claude", "codex", "claude"]);
    expect(harness.mockProviderWasUsed()).toBe(false);
    expect(harness.worktrees()).toEqual([
      expect.objectContaining({ role: "lead" }),
      expect.objectContaining({ role: "collaborator" }),
    ]);
    expect(harness.codexContext().payload.peer.checkpointOid).toBe(harness.claudeCheckpointOid());
    expect(harness.finalClaudeContext().payload.peer.messages.some((message) => message.author === "codex")).toBe(true);
    expect(harness.persistedContextHashes()).toHaveLength(3);
    expect(harness.timelineTypes()).toEqual(expect.arrayContaining([
      "provider.session.started",
      "checkpoint.created",
      "test.completed",
      "integration.candidate.ready",
    ]));
    expect(harness.taskState()).toBe("HumanApproval");
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the registry/real slice are absent**

Run: `pnpm exec vitest run tests/unit/providers/provider-registry.test.ts tests/integration/providers/dual-agent-provider-task.test.ts`

Expected: FAIL with `Cannot find module '../../../src/worker/providers/provider-registry'`.

- [ ] **Step 3: Implement policy-gated runner-backed adapters**

```ts
// src/worker/providers/provider-registry.ts
import { PUBLIC_PROVIDER_RELEASE_POLICY } from "../../shared/config/provider-release-policy";

export function createProviderRegistry(input: ProviderRegistryInput = productionProviderDependencies()): ProviderRegistry {
  const adapters = new Map<ProviderId, ProviderAdapter>();
  adapters.set("codex", input.createCodexAdapter());
  if (input.policy.claudeSubscription.enabled) adapters.set("claude", input.createClaudeAdapter());
  return {
    get: (provider) => adapters.get(provider) ?? null,
    requireRunnable: (provider) => {
      const adapter = adapters.get(provider);
      if (adapter) return adapter;
      if (provider === "claude") throw new Error("Claude subscription runs are disabled by public release policy");
      throw new Error(`Provider ${provider} is not ready`);
    },
  };
}

function productionProviderDependencies(): ProviderRegistryInput {
  return {
    policy: PUBLIC_PROVIDER_RELEASE_POLICY,
    createClaudeAdapter: createProductionClaudeAdapter,
    createCodexAdapter: createProductionCodexAdapter,
  };
}
```

`RunnerBackedAdapter` implements every `ProviderAdapter` method by composing health service, capabilities, pure normalizer, coordinator, supervisor, and session service. It never imports either SDK. The private test policy lives only under `tests/helpers` and is passed explicitly with fake SDK factories; no environment variable or production runtime branch can enable Claude.

- [ ] **Step 4: Wire the existing task engine and timeline to the real adapter port**

Replace Milestone 2's default `MockProvider` registration with the registry's `TaskProviderPort`; retain MockProvider only in its own unit tests. Before each start, require ready health, build/persist context, bind read-only tools, and start the adapter. Persist session/event/checkpoint/test/candidate timeline events through the existing EventStore and render session state/context hash in the existing Task Inspector. A Codex `permission_denied` terminal result creates a durable app-level approval; an approved follow-up calls a new `resumeRun` or recovery start, never mutates the completed run.

- [ ] **Step 5: Run the real-adapter/fake-SDK task slice and workflow regression suite**

Run: `pnpm exec vitest run tests/unit/providers/provider-registry.test.ts tests/integration/providers/dual-agent-provider-task.test.ts tests/integration/tasks && pnpm typecheck`

Expected: exit 0; public Claude gate, private test policy, no MockProvider use, two worktrees, peer checkpoint/diff/test context, three stored hashes, session IDs, review/revision, HumanApproval candidate, cancellation, and existing two-round limits PASS.

- [ ] **Step 6: Commit**

```bash
git add src/worker/providers/provider-registry.ts src/worker/providers/runner-backed-adapter.ts src/worker/tasks/task-engine.ts src/worker/runtime.ts src/worker/protocol/worker-router.ts src/renderer/state/timeline-store.ts src/renderer/features/tasks/task-inspector.tsx tests/helpers/private-provider-test-policy.ts tests/helpers/dual-agent-provider-harness.ts tests/integration/providers/dual-agent-provider-task.test.ts tests/unit/providers/provider-registry.test.ts
git commit -m "feat: run two-agent tasks through provider adapters"
```

### Task 14: Verify Onboarding, Restart Recovery, and Private Real-Provider Smoke

**Files:**
- Create: `e2e/provider-onboarding.spec.ts`
- Create: `e2e/dual-agent-provider-task.spec.ts`
- Create: `e2e/fixtures/provider-test-main.ts`
- Create: `tests/private/providers/real-provider-smoke.test.ts`
- Modify: `vitest.config.ts`
- Modify: `playwright.config.ts`

**Interfaces:**
- Consumes: the production Electron entrypoint with test-only dependency injection, private test policy, external CLI paths selected outside Renderer, all provider services, and existing E2E snapshot/replay helpers.
- Produces: public-CI E2E coverage and an explicitly excluded `tests/private` real-provider verification target, including authoritative Codex config-isolation evidence; no application runtime override.

- [ ] **Step 1: Write failing onboarding and restart E2E tests**

```ts
// e2e/provider-onboarding.spec.ts
import { expect, test } from "@playwright/test";
import { launchProviderTestApp } from "./fixtures/provider-test-main";

test("onboarding discovers Codex and shows Claude public policy disabled", async () => {
  const app = await launchProviderTestApp();
  const page = await app.firstWindow();
  await expect(page.getByText("Connect external coding agents")).toBeVisible();
  await page.getByRole("button", { name: "Choose Codex CLI" }).click();
  await expect(page.getByLabel("Codex health")).toContainText("ready");
  await expect(page.getByLabel("Claude health")).toContainText("policy disabled");
  await expect(page.getByText(/context is sent to the selected provider/i)).toBeVisible();
  await app.close();
});
```

```ts
// e2e/dual-agent-provider-task.spec.ts
import { expect, test } from "@playwright/test";
import { launchProviderTestApp } from "./fixtures/provider-test-main";

test("two adapters stream, stop, persist, restart, and recover", async () => {
  const app = await launchProviderTestApp({ privateClaudeTestPolicy: true });
  const page = await app.firstWindow();
  await page.getByRole("textbox", { name: "Message" }).fill("@Claude add and review the fixture");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve task scope" }).click();
  await expect(page.getByText("Claude session started")).toBeVisible();
  await expect(page.getByText("Codex review completed")).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Interrupted")).toBeVisible();
  await app.relaunch();
  const restarted = await app.firstWindow();
  await expect(restarted.getByText("Recovery preview")).toBeVisible();
  await restarted.getByRole("button", { name: "Resume task" }).click();
  await expect(restarted.getByText("Integration candidate ready")).toBeVisible();
  await app.close();
});
```

- [ ] **Step 2: Run E2E tests and verify the test entrypoint is absent**

Run: `pnpm exec playwright test e2e/provider-onboarding.spec.ts e2e/dual-agent-provider-task.spec.ts`

Expected: FAIL with an import error for `e2e/fixtures/provider-test-main.ts`.

- [ ] **Step 3: Add test-only Electron wiring and private smoke isolation**

`provider-test-main.ts` injects fake external CLI executables and fake SDK factories into the same production Main/worker/provider constructors; it does not replace `RunnerBackedAdapter`, context builder, coordinator, supervisor contract, task engine, database, or timeline. `vitest.config.ts` excludes `tests/private/**/*.test.ts` from normal unit/integration runs. The private test refuses to start unless all three non-secret controls are present:

```ts
const enabled = process.env.BRANCHESTRA_PRIVATE_PROVIDER_SMOKE === "1";
const claudePath = process.env.BRANCHESTRA_CLAUDE_PATH;
const codexPath = process.env.BRANCHESTRA_CODEX_PATH;
if (!enabled || !claudePath || !codexPath) {
  throw new Error("Private provider smoke requires explicit enablement and both external CLI paths");
}
```

The private test canonicalizes both paths, revalidates the committed config lock, runs the same version/auth probes and adapters, asserts one Claude session ID and one Codex thread ID, performs a read-only prompt in temporary Git worktrees, and removes prompt/event bodies from assertion output. It never supplies a key, token, base URL, or caller-authored provider config; the only SDK config is the production lock replay object, and it never mutates the public release policy. A private-only policy object is injected from `tests/helpers/private-provider-test-policy.ts`.

For Codex, create a temporary home-level `config.toml` and worktree `.codex/config.toml` that both select a uniquely named custom provider whose `base_url` points to a test-owned loopback canary. Keep the real CLI's normal credential access through its supported keyring/file mode, load the reviewed lock with version mismatch forbidden, complete the real read-only turn, and assert the canary accepted zero requests. The sanitized report records `configLockHash`, `configLockCliVersion: "0.144.6"`, and `configIsolationCanary: true`. If the controlled machine cannot preserve its supported ChatGPT auth while running this test, the report is not generated and public Codex remains disabled; do not copy or symlink credential files as a workaround.

- [ ] **Step 4: Run public E2E and the complete non-private verification suite**

Run: `pnpm typecheck && pnpm test:unit && pnpm test:integration && pnpm build && pnpm exec playwright test e2e/provider-onboarding.spec.ts e2e/dual-agent-provider-task.spec.ts`

Expected: exit 0; typecheck, unit, integration, onboarding, two-Agent restart/recovery E2E, and production build PASS, while output confirms `tests/private` was not collected.

- [ ] **Step 5: Run the private real-provider smoke only on an approved development Mac**

Run: `BRANCHESTRA_PRIVATE_PROVIDER_SMOKE=1 BRANCHESTRA_CLAUDE_PATH=/opt/homebrew/bin/claude BRANCHESTRA_CODEX_PATH=/opt/homebrew/bin/codex pnpm exec vitest run --config vitest.private.config.ts tests/private/providers/real-provider-smoke.test.ts --maxWorkers=1`

Expected: exit 0; both external executable realpaths pass the reviewed matrix/auth probes, Claude returns a session ID, Codex returns a thread ID, the authoritative lock defeats both malicious config layers with zero canary requests, both read-only worktree prompts complete, and no credential or raw auth payload is printed.

- [ ] **Step 6: Commit**

```bash
git add e2e/provider-onboarding.spec.ts e2e/dual-agent-provider-task.spec.ts e2e/fixtures/provider-test-main.ts tests/private/providers/real-provider-smoke.test.ts vitest.config.ts vitest.private.config.ts playwright.config.ts
git commit -m "test: verify provider adapter vertical slice"
```

## Release-Milestone Handoff

This provider milestone deliberately stops at required external paths, source import guards, public Claude compile-time policy, and test-injectable SDK factories. The release plan must exclude `@anthropic-ai/claude-agent-sdk-*` platform binary packages and the `@openai/codex` executable payload from packaged app inputs, then scan unpacked ASAR, arm64 DMG, and x64 DMG contents for Provider executable names and binary signatures before signing. That release work must consume these external-path-only constructors; it must not add an SDK-default or bundled-binary fallback.

## Implementation References

- [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript): `query`, `Options`, `pathToClaudeCodeExecutable`, `settingSources`, `strictMcpConfig`, `SandboxSettings`, `Query.close`, and session resume.
- [Claude Agent SDK user-input reference](https://code.claude.com/docs/en/agent-sdk/user-input): `canUseTool` allow/deny behavior and callback cancellation.
- [OpenAI Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md): explicit environment replacement, `startThread`, `resumeThread`, and `runStreamed`.
- [OpenAI Codex SDK `CodexOptions`](https://github.com/openai/codex/blob/main/sdk/typescript/src/codexOptions.ts): `codexPathOverride`, `apiKey`, `baseUrl`, `config`, and `env` constructor surface.
- [OpenAI Codex SDK `ThreadOptions`](https://github.com/openai/codex/blob/main/sdk/typescript/src/threadOptions.ts): worktree, sandbox, approval, network, and web-search controls.
- [OpenAI Codex 0.144.x config-lock schema](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/config/src/config_toml.rs): versioned lock metadata and `load_path` as the authoritative effective config.
- [OpenAI Codex 0.144.x config loader](https://github.com/openai/codex/blob/rust-v0.144.4/codex-rs/core/src/config/mod.rs): lock replay replaces ordinary config layers while retaining runtime harness overrides and managed requirements.
