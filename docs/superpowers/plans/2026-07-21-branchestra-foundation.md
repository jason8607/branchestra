# Branchestra Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working Milestone 1 vertical slice that adds an existing Git project, persists multiple rooms and local user messages, replays each room by `room_seq`, renders a secure three-column Electron timeline, and preserves the result across a full app restart.

**Architecture:** Electron Main owns only the secure window, native project-directory dialog, single-instance lifecycle, renderer IPC validation, and a supervised `utilityProcess`. The utility worker is the sole owner of `node:sqlite`, the durable worker lease, Git validation, domain services, and command handling; every state mutation is deduplicated and committed before its response is acknowledged. Renderer state is rebuilt from a snapshot plus cursor replay through a preload bridge that exposes only `request` and `subscribe`.

**Tech Stack:** Node.js 24.18.0, pnpm 11.15.1, Electron 43.1.1, electron-vite 5.0.0, React/React DOM 19.2.7, Vite 7.3.6, `@vitejs/plugin-react` 5.2.0, `@swc/core` 1.15.46, TypeScript 6.0.3, Zod 4.4.3, `node:sqlite` `DatabaseSync`, Vitest 4.1.10, and Playwright 1.61.1.

## Global Constraints

- Use exactly Node.js `24.18.0` and declare it in `.nvmrc` and `package.json#engines.node`.
- Use exactly pnpm `11.15.1` and declare `packageManager: "pnpm@11.15.1"`.
- Pin Electron `43.1.1`, electron-vite `5.0.0`, React and React DOM `19.2.7`, Vite `7.3.6`, `@vitejs/plugin-react` `5.2.0`, `@swc/core` `1.15.46`, TypeScript `6.0.3`, Zod `4.4.3`, Vitest `4.1.10`, and `@playwright/test` `1.61.1` without ranges.
- Pin ESLint `10.6.0`, `@eslint/js` `10.0.1`, `typescript-eslint` `8.65.0`, `globals` `17.7.0`, Testing Library React/DOM/User Event `16.3.2`/`10.4.1`/`14.6.1`, and jsdom `29.1.1` without ranges; later milestones consume these existing tools rather than installing them after first use.
- Keep one package, ESM (`"type": "module"`), strict TypeScript, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- Keep source roots exactly under `src/main`, `src/preload`, `src/renderer`, `src/worker`, and `src/shared/contracts`; keep tests under `tests/unit`, `tests/integration`, `tests/fixtures`, and `e2e`.
- Use Electron security defaults explicitly: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no `<webview>`, denied navigation, and denied new windows.
- Preload exposes exactly `request(command)` and `subscribe(listener)`; it never exposes Electron, Node.js, filesystem, shell, dialog, or raw IPC objects.
- Every IPC envelope contains `v`, `requestId`, `idempotencyKey`, `workerGeneration`, `type`, and `payload`; protocol version is `1`, generation is a UUID string, and encoded envelopes are at most `65_536` bytes.
- The zero UUID `00000000-0000-0000-0000-000000000000` is accepted only for the first read-only `state.getSnapshot` request at Renderer-to-Main bootstrap; Main replaces it with the current generation before sending to Worker. Every mutation must carry the exact active generation.
- A state-changing command is acknowledged only after its `idempotency_records` row and all domain changes commit in one SQLite transaction. Reusing a key with a different command hash is rejected.
- Main owns windows, dialogs, app lifecycle, IPC validation, and worker supervision only. Worker owns SQLite, durable domain state, Git inspection, and the worker lease.
- Use Node 24.18's built-in `node:sqlite` `DatabaseSync`; do not add `better-sqlite3` or any other SQLite package.
- Open the file-backed database with WAL, foreign keys, and transactions; allocate `room_seq` monotonically and independently per room.
- Obtain `app.requestSingleInstanceLock()` before starting Worker or creating a window. Worker must acquire its durable lease before sending the generation/version ready handshake.
- Resolve a native directory choice in Main, then send it only Main-to-Worker. Worker canonicalizes and validates repository root, Git common dir, and `HEAD` using `execFile` with an argv array and `shell: false`.
- Renderer can request `project.pickExisting` with an empty payload; it can never send a selected path or request arbitrary filesystem access.
- Inject the project dialog adapter in tests. The Electron E2E fixed-path adapter is enabled only by an explicit E2E process flag and remains Main-side.
- Milestone 1 includes projects, rooms, local user messages, snapshot/replay, worker supervision, and the timeline shell. It excludes tasks, worktrees, approvals, Provider adapters, Agent runs, SDKs, and Provider processes.
- Use `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm typecheck`, and `pnpm build` as the stable verification scripts consumed by later milestones.
- Keep pnpm 11 dependency scripts fail-closed: `pnpm-workspace.yaml` may allow only `esbuild: true` and `'@swc/core': true`; any newly discovered build script is a review blocker rather than an interactive blanket approval.

---

## Planned File Map

| Path | Single responsibility |
|---|---|
| `.nvmrc`, `.gitignore`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Reproducible single-package runtime, scripts, exact dependency graph, and reviewed dependency-build allowlist. |
| `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.renderer.json`, `vitest.config.ts`, `playwright.config.ts` | Build and test configuration for Main, Preload, Worker, Renderer, and Electron E2E. |
| `src/shared/contracts/domain.ts` | Zod-backed Project, Room, local user message, room event, snapshot, and replay-page values. |
| `src/shared/contracts/protocol.ts` | Versioned and size-bounded Renderer/Main/Worker commands, responses, events, and envelope helpers. |
| `src/shared/contracts/renderer-api.ts` | The only two methods visible on `window.branchestra`. |
| `src/main/window-options.ts` | Secure `BrowserWindow` policy with no lifecycle or domain logic. |
| `src/main/lifecycle.ts` | Single-instance and re-entrant quit coordination. |
| `src/main/worker/utility-process-adapter.ts` | Thin production adapter around Electron `utilityProcess.fork`. |
| `src/main/worker/supervisor.ts` | Generation creation, ready handshake, request correlation, bounded restart, subscriptions, and quit deadline. |
| `src/main/dialog/project-dialog.ts` | Injectable directory picker; no repository validation. |
| `src/main/ipc/renderer-gateway.ts` | Sender/schema/size/generation checks and `project.pickExisting` translation. |
| `src/main/bootstrap.ts`, `src/main/index.ts` | Composition root for Main-owned adapters only. |
| `src/preload/api.ts`, `src/preload/index.ts` | Generation-aware envelope creation and the two-method context bridge. |
| `src/worker/storage/database.ts` | `DatabaseSync` wrapper implementing the canonical `Database` seam and nested transactions. |
| `src/worker/storage/migrations.ts` | Ordered, transactional schema migrations. |
| `src/worker/storage/repositories.ts` | Project and Room persistence queries. |
| `src/worker/storage/event-store.ts` | Canonical `EventStore.append/snapshot/after` implementation. |
| `src/worker/storage/idempotency-store.ts` | Durable command-hash dedupe and committed response replay. |
| `src/worker/storage/worker-lease-store.ts` | Exclusive generation lease acquisition, heartbeat, and release. |
| `src/worker/process/exec-file.ts` | Bounded, no-shell executable runner using argv. |
| `src/worker/git/inspect-repository.ts` | Canonical Git root/common-dir/HEAD inspection. |
| `src/worker/domain/project-service.ts` | Add-existing-project domain transaction. |
| `src/worker/domain/room-service.ts` | Multi-room creation, local message append, snapshot, and replay. |
| `src/worker/protocol/command-handler.ts`, `src/worker/protocol/handlers.ts`, `src/worker/protocol/worker-router.ts` | Exact handler seam, command-to-service mapping, generation rejection, and response envelopes. |
| `src/worker/runtime.ts`, `src/worker/index.ts` | Sole-owner worker composition, parent-port dispatch, ready/quit handshake, and resource cleanup. |
| `src/renderer/state/timeline-store.ts` | Snapshot hydration, `room_seq` gap replay, duplicate suppression, commands, and subscriptions. |
| `src/renderer/components/*.tsx`, `src/renderer/App.tsx`, `src/renderer/main.tsx`, `src/renderer/styles.css`, `src/renderer/index.html` | Three-column Project/Room, Timeline, Inspector, and local-message UI. |
| `tests/unit/**`, `tests/integration/**`, `tests/fixtures/**`, `e2e/**` | Contract, storage, Git, supervision, renderer-state, and real Electron restart coverage. |

### Task 1: Exact Toolchain and Secure Electron Shell

**Files:**
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-lock.yaml` (generated by pnpm 11.15.1)
- Create: `pnpm-workspace.yaml`
- Create: `electron.vite.config.ts`
- Create: `eslint.config.mjs`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `tsconfig.renderer.json`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `src/main/window-options.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/styles.css`
- Test: `tests/unit/window-options.test.ts`

**Interfaces:**
- Consumes: No product interface; this is the first executable slice.
- Produces: `createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions`; exact package scripts `dev`, `build`, `lint`, `typecheck`, `test`, `test:unit`, `test:integration`, and `test:e2e`.

- [ ] **Step 1: Create the pinned package metadata, strict compiler/test configuration, and the failing security test**

Create `.nvmrc` with `24.18.0`, create `.gitignore` with `node_modules`, `out`, `dist`, `test-results`, `playwright-report`, and `*.sqlite3*`, and create `package.json` exactly as follows:

```json
{
  "name": "branchestra",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "packageManager": "pnpm@11.15.1",
  "engines": { "node": "24.18.0" },
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.renderer.json --noEmit",
    "test": "pnpm test:unit && pnpm test:integration",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration --testTimeout=15000",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.61.1",
    "@swc/core": "1.15.46",
    "@testing-library/dom": "10.4.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.1",
    "@types/node": "24.13.3",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "5.2.0",
    "electron": "43.1.1",
    "electron-vite": "5.0.0",
    "eslint": "10.6.0",
    "globals": "17.7.0",
    "jsdom": "29.1.1",
    "typescript": "6.0.3",
    "typescript-eslint": "8.65.0",
    "vite": "7.3.6",
    "vitest": "4.1.10"
  }
}
```

Create the project-level pnpm 11 build allowlist exactly as follows; do not use `dangerouslyAllowAllBuilds`, global approval state, or an interactive blanket approval:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  '@swc/core': true
  esbuild: true
```

Create the flat ESLint configuration and make the Renderer import boundary executable from Milestone 1:

```js
// eslint.config.mjs
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "out/**", "playwright-report/**", "release/**", "test-results/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.{js,mjs,cjs}"], languageOptions: { globals: globals.nodeBuiltin } },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["node:*", "electron", "@anthropic-ai/*", "@openai/*", "**/main/**", "**/worker/**"],
          message: "Renderer code may use only Renderer/shared contracts and the typed preload bridge",
        }],
      }],
    },
  },
);
```

Use this shared `tsconfig.json` body and extend it from the two environment configs:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": false
  }
}
```

`tsconfig.node.json` adds `types: ["node", "electron"]` and includes configuration files plus `src/main/**/*.ts`, `src/preload/**/*.ts`, `src/worker/**/*.ts`, `src/shared/**/*.ts`, `tests/**/*.ts`, and `e2e/**/*.ts`. `tsconfig.renderer.json` adds `jsx: "react-jsx"`, `lib: ["ES2024", "DOM", "DOM.Iterable"]`, and includes `src/renderer/**/*`, `src/shared/**/*`, and `tests/**/*.tsx`.

Create the build and test configs:

```ts
// electron.vite.config.ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { root: resolve("src/renderer"), plugins: [react()] }
});
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    restoreMocks: true
  }
});
```

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: { trace: "retain-on-failure" }
});
```

Write the test before creating `src/main/window-options.ts`:

```ts
// tests/unit/window-options.test.ts
import { describe, expect, it } from "vitest";
import { createWindowOptions } from "../../src/main/window-options";

describe("createWindowOptions", () => {
  it("keeps the renderer isolated from Node and webviews", () => {
    const options = createWindowOptions("/app/preload.js");
    expect(options.webPreferences).toMatchObject({
      preload: "/app/preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    });
  });
});
```

- [ ] **Step 2: Install with the pinned package manager and generate the lockfile**

Run: `corepack pnpm install`

Run: `corepack pnpm peers check`

Expected: pnpm reports version `11.15.1`, installs only the exact direct versions above (including Renderer test and lint tooling), creates `pnpm-lock.yaml`, exits without `ERR_PNPM_IGNORED_BUILDS`, and reports no peer issues. Because pnpm 11 defaults `strictDepBuilds` to true, any build script other than the reviewed `esbuild` and `@swc/core` entries fails installation.

- [ ] **Step 3: Run the security test to verify it fails**

Run: `pnpm exec vitest run tests/unit/window-options.test.ts`

Expected: FAIL because `../../src/main/window-options` cannot be resolved.

- [ ] **Step 4: Implement the smallest secure window and renderable shell**

```ts
// src/main/window-options.ts
import type { BrowserWindowConstructorOptions } from "electron";

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  };
}
```

```ts
// src/main/index.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { createWindowOptions } from "./window-options";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(createWindowOptions(join(currentDirectory, "../preload/index.js")));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(currentDirectory, "../renderer/index.html"));
  return window;
}

void app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
```

Keep `src/preload/index.ts` as the ESM module `export {};` until the typed bridge task. Create `src/renderer/index.html` with this restrictive packaged-app CSP and a single root node:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Branchestra</title>
  </head>
  <body><div id="root"></div><script type="module" src="/main.tsx"></script></body>
</html>
```

```tsx
// src/renderer/App.tsx
export function App(): React.JSX.Element {
  return <main className="shell"><h1>Branchestra</h1></main>;
}
```

```tsx
// src/renderer/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root is missing");
createRoot(root).render(<StrictMode><App /></StrictMode>);
```

Set `src/renderer/styles.css` to `:root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color-scheme: dark; } body { margin: 0; background: #111319; color: #f4f5f7; }`.

- [ ] **Step 5: Verify the shell passes tests, type checking, and production build**

Run: `pnpm exec vitest run tests/unit/window-options.test.ts`

Expected: PASS with 1 test.

Run: `pnpm typecheck`

Expected: both TypeScript invocations exit 0 with no diagnostics.

Run: `pnpm lint`

Expected: all source/config/test files pass and a temporary Renderer import of `node:fs` is rejected by `no-restricted-imports`.

Run: `pnpm build`

Expected: electron-vite builds Main, Preload, and Renderer into `out/` with no errors.

- [ ] **Step 6: Commit**

```bash
git add .nvmrc .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml electron.vite.config.ts eslint.config.mjs tsconfig.json tsconfig.node.json tsconfig.renderer.json vitest.config.ts playwright.config.ts src/main/window-options.ts src/main/index.ts src/preload/index.ts src/renderer/index.html src/renderer/main.tsx src/renderer/App.tsx src/renderer/styles.css tests/unit/window-options.test.ts
git commit -m "feat: scaffold secure Electron shell"
```

### Task 2: Versioned Zod Domain and IPC Contracts

**Files:**
- Create: `src/shared/contracts/domain.ts`
- Create: `src/shared/contracts/protocol.ts`
- Create: `src/shared/contracts/renderer-api.ts`
- Test: `tests/unit/protocol.test.ts`

**Interfaces:**
- Consumes: Strict ESM TypeScript and Zod `4.4.3` from Task 1.
- Produces: `Project`, `Room`, `UserMessage`, `RoomEvent`, `AppSnapshot`, `RoomEventCursor`, `RoomEventPage`, `Clock`, `IdGenerator`; `RendererCommand`, `WorkerCommand`, four envelope schemas and inferred types; `BranchestraApi.request` and `BranchestraApi.subscribe`.

- [ ] **Step 1: Write failing contract tests for required metadata, strict payloads, generation bootstrap, and size limits**

```ts
// tests/unit/protocol.test.ts
import { describe, expect, it } from "vitest";
import {
  MAX_IPC_BYTES,
  PROTOCOL_VERSION,
  ZERO_WORKER_GENERATION,
  assertEnvelopeSize,
  RendererRequestEnvelopeSchema,
  WorkerRequestEnvelopeSchema
} from "../../src/shared/contracts/protocol";

const metadata = {
  v: PROTOCOL_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "command-1",
  workerGeneration: "22222222-2222-4222-8222-222222222222"
} as const;

describe("IPC contracts", () => {
  it("accepts an exact renderer room command", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "room.create",
      payload: { projectId: "33333333-3333-4333-8333-333333333333", title: "Ideas" }
    }).type).toBe("room.create");
  });

  it("does not expose a renderer command carrying a filesystem path", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "project.addExisting",
      payload: { selectedPath: "/private/repository" }
    })).toThrow();
  });

  it("allows the zero generation only for renderer snapshot bootstrap", () => {
    expect(RendererRequestEnvelopeSchema.parse({
      ...metadata,
      workerGeneration: ZERO_WORKER_GENERATION,
      type: "state.getSnapshot",
      payload: {}
    }).type).toBe("state.getSnapshot");
    expect(() => WorkerRequestEnvelopeSchema.parse({
      ...metadata,
      workerGeneration: ZERO_WORKER_GENERATION,
      type: "message.post",
      payload: { roomId: metadata.requestId, body: "unsafe" }
    })).toThrow();
  });

  it("rejects unknown keys and envelopes over 65536 encoded bytes", () => {
    expect(() => RendererRequestEnvelopeSchema.parse({
      ...metadata,
      type: "project.pickExisting",
      payload: {},
      extra: true
    })).toThrow();
    expect(() => assertEnvelopeSize({ body: "x".repeat(MAX_IPC_BYTES) })).toThrow(/65536/);
  });
});
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `pnpm exec vitest run tests/unit/protocol.test.ts`

Expected: FAIL because `src/shared/contracts/protocol.ts` does not exist.

- [ ] **Step 3: Define the domain schemas and exact snapshot/replay values**

```ts
// src/shared/contracts/domain.ts
import { z } from "zod";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const GitOidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const ProjectSchema = z.object({
  id: UuidSchema,
  repositoryRoot: z.string().min(1),
  gitCommonDir: z.string().min(1),
  displayName: z.string().min(1).max(200),
  headOid: GitOidSchema,
  defaultBranch: z.string().min(1).nullable(),
  createdAt: TimestampSchema
}).strict();

export const RoomSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  title: z.string().trim().min(1).max(120),
  createdAt: TimestampSchema
}).strict();

export const UserMessageSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  body: z.string().trim().min(1).max(20_000),
  createdAt: TimestampSchema
}).strict();

export const RoomEventSchema = z.object({
  id: UuidSchema,
  roomId: UuidSchema,
  roomSeq: z.number().int().positive(),
  type: z.literal("message.posted"),
  actor: z.enum(["user", "claude", "codex", "system"]),
  payload: UserMessageSchema,
  createdAt: TimestampSchema
}).strict();

export const AppSnapshotSchema = z.object({
  projects: z.array(ProjectSchema),
  rooms: z.array(RoomSchema),
  roomCursors: z.record(UuidSchema, z.number().int().nonnegative())
}).strict();

export const RoomEventCursorSchema = z.object({
  roomId: UuidSchema,
  roomSeq: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500)
}).strict();

export const RoomEventPageSchema = z.object({
  roomId: UuidSchema,
  events: z.array(RoomEventSchema),
  nextRoomSeq: z.number().int().nonnegative(),
  hasMore: z.boolean()
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;
export type RoomEventCursor = z.infer<typeof RoomEventCursorSchema>;
export type RoomEventPage = z.infer<typeof RoomEventPageSchema>;

export interface Clock { now(): string; }
export interface IdGenerator { next(): string; }
```

- [ ] **Step 4: Define every allowed command and envelope, including the Main-only path command**

In `src/shared/contracts/protocol.ts`, define the constants and metadata once, then enumerate the complete Renderer and Worker command sets:

```ts
import { z } from "zod";
import {
  AppSnapshotSchema,
  ProjectSchema,
  RoomEventCursorSchema,
  RoomEventPageSchema,
  RoomEventSchema,
  RoomSchema
} from "./domain";

export const PROTOCOL_VERSION = 1 as const;
export const MAX_IPC_BYTES = 65_536;
export const ZERO_WORKER_GENERATION = "00000000-0000-0000-0000-000000000000";

const UuidSchema = z.string().uuid();
const GenerationSchema = UuidSchema.refine((value) => value !== ZERO_WORKER_GENERATION, "active worker generation required");
const base = {
  v: z.literal(PROTOCOL_VERSION),
  requestId: UuidSchema,
  idempotencyKey: z.string().min(1).max(128),
  workerGeneration: GenerationSchema
};
const empty = z.object({}).strict();
const roomCreate = z.object({ projectId: UuidSchema, title: z.string().trim().min(1).max(120) }).strict();
const messagePost = z.object({ roomId: UuidSchema, body: z.string().trim().min(1).max(20_000) }).strict();

export const RendererRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, workerGeneration: z.union([GenerationSchema, z.literal(ZERO_WORKER_GENERATION)]), type: z.literal("state.getSnapshot"), payload: empty }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.pickExisting"), payload: empty }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict()
]);

export const WorkerRequestEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("state.getSnapshot"), payload: empty }).strict(),
  z.object({ ...base, type: z.literal("room.replay"), payload: RoomEventCursorSchema }).strict(),
  z.object({ ...base, type: z.literal("project.addExisting"), payload: z.object({ selectedPath: z.string().min(1) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("room.create"), payload: roomCreate }).strict(),
  z.object({ ...base, type: z.literal("message.post"), payload: messagePost }).strict(),
  z.object({ ...base, type: z.literal("worker.prepareQuit"), payload: z.object({ deadlineMs: z.number().int().positive() }).strict() }).strict()
]);

const responseData = z.union([AppSnapshotSchema, RoomEventPageSchema, ProjectSchema, RoomSchema, RoomEventSchema, z.object({ cancelled: z.literal(true) }).strict(), z.object({ prepared: z.literal(true) }).strict()]);
export const WorkerResponseEnvelopeSchema = z.object({
  ...base,
  type: z.literal("response"),
  payload: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), requestType: z.string().min(1), data: responseData, replayed: z.boolean() }).strict(),
    z.object({ ok: z.literal(false), requestType: z.string().min(1), code: z.enum(["INVALID_REQUEST", "STALE_WORKER_GENERATION", "IDEMPOTENCY_CONFLICT", "LEASE_HELD", "NOT_FOUND", "GIT_INVALID", "INTERNAL"]), message: z.string().min(1) }).strict()
  ])
}).strict();

export const WorkerEventEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("worker.ready"), payload: z.object({ protocolVersion: z.literal(PROTOCOL_VERSION) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("worker.disconnected"), payload: z.object({ reason: z.string().min(1) }).strict() }).strict(),
  z.object({ ...base, type: z.literal("room.event"), payload: RoomEventSchema }).strict(),
  z.object({ ...base, type: z.literal("state.invalidated"), payload: z.object({ roomId: UuidSchema.nullable() }).strict() }).strict()
]);

export type RendererRequestEnvelope = z.infer<typeof RendererRequestEnvelopeSchema>;
export type WorkerRequestEnvelope = z.infer<typeof WorkerRequestEnvelopeSchema>;
export type WorkerResponseEnvelope = z.infer<typeof WorkerResponseEnvelopeSchema>;
export type WorkerEventEnvelope = z.infer<typeof WorkerEventEnvelopeSchema>;
type CommandFromEnvelope<E> = E extends { type: infer T; payload: infer P }
  ? { type: T; payload: P }
  : never;
export type RendererCommand = CommandFromEnvelope<RendererRequestEnvelope> extends infer C
  ? C extends { type: string; payload: unknown }
    ? C & { idempotencyKey: string }
    : never
  : never;
export type WorkerCommand = CommandFromEnvelope<WorkerRequestEnvelope>;
export type WorkerResponsePayload = WorkerResponseEnvelope["payload"];

export function assertEnvelopeSize(value: unknown): void {
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_IPC_BYTES) throw new Error(`IPC envelope exceeds ${MAX_IPC_BYTES} bytes`);
}
```

The production implementation may factor repeated Zod fields into helpers, but the exported names, exact command lists, strict-object behavior, generation rule, and maximum size above must remain unchanged.

- [ ] **Step 5: Define the only renderer-visible API**

```ts
// src/shared/contracts/renderer-api.ts
import type { RendererCommand, WorkerEventEnvelope, WorkerResponseEnvelope } from "./protocol";

export interface BranchestraApi {
  request(command: RendererCommand): Promise<WorkerResponseEnvelope>;
  subscribe(listener: (event: WorkerEventEnvelope) => void): () => void;
}

declare global {
  interface Window {
    branchestra: BranchestraApi;
  }
}
```

- [ ] **Step 6: Run contract and type checks**

Run: `pnpm exec vitest run tests/unit/protocol.test.ts`

Expected: PASS with 4 tests; the arbitrary-path and oversized cases are rejected.

Run: `pnpm typecheck`

Expected: exit 0 with all inferred envelope unions and renderer API types valid.

- [ ] **Step 7: Commit**

```bash
git add src/shared/contracts/domain.ts src/shared/contracts/protocol.ts src/shared/contracts/renderer-api.ts tests/unit/protocol.test.ts
git commit -m "feat: define versioned IPC contracts"
```

### Task 3: `node:sqlite` Database Seam and Transactional Migrations

**Files:**
- Create: `src/worker/storage/database.ts`
- Create: `src/worker/storage/migrations.ts`
- Test: `tests/integration/database.test.ts`

**Interfaces:**
- Consumes: Node 24.18 `DatabaseSync` and the strict worker TypeScript environment.
- Produces: canonical `Database { exec, prepare, transaction, close }`; `openDatabase(filePath: string): Database`; `runMigrations(database: Database): void`.

- [ ] **Step 1: Write the failing file-backed database test**

```ts
// tests/integration/database.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { runMigrations } from "../../src/worker/storage/migrations";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker database", () => {
  it("enables WAL and foreign keys and migrates exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-db-"));
    roots.push(root);
    const database = openDatabase(join(root, "branchestra.sqlite3"));
    runMigrations(database);
    runMigrations(database);

    expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({ count: 1 });
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables).toEqual(expect.arrayContaining([
      { name: "idempotency_records" },
      { name: "projects" },
      { name: "room_events" },
      { name: "rooms" },
      { name: "schema_migrations" },
      { name: "worker_leases" }
    ]));
    database.close();
  });

  it("rolls back an outer transaction when a nested write fails", () => {
    const database = openDatabase(":memory:");
    database.exec("CREATE TABLE values_under_test (value TEXT NOT NULL)");
    expect(() => database.transaction(() => {
      database.prepare("INSERT INTO values_under_test(value) VALUES (?)").run("outer");
      database.transaction(() => {
        database.prepare("INSERT INTO values_under_test(value) VALUES (?)").run("inner");
        throw new Error("abort");
      });
    })).toThrow("abort");
    expect(database.prepare("SELECT value FROM values_under_test").all()).toEqual([]);
    database.close();
  });
});
```

- [ ] **Step 2: Run the database test to verify it fails**

Run: `pnpm exec vitest run tests/integration/database.test.ts`

Expected: FAIL because `src/worker/storage/database.ts` cannot be resolved.

- [ ] **Step 3: Implement the canonical synchronous database wrapper with nested savepoints**

```ts
// src/worker/storage/database.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(work: () => T): T;
  close(): void;
}

class SqliteDatabase implements Database {
  readonly #raw: DatabaseSync;
  #transactionDepth = 0;

  constructor(raw: DatabaseSync) { this.#raw = raw; }
  exec(sql: string): void { this.#raw.exec(sql); }
  prepare(sql: string): StatementSync { return this.#raw.prepare(sql); }

  transaction<T>(work: () => T): T {
    const depth = this.#transactionDepth;
    const savepoint = `branchestra_${depth}`;
    this.#raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const value = work();
      if (value instanceof Promise) throw new TypeError("Database transactions must be synchronous");
      this.#transactionDepth -= 1;
      this.#raw.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      this.#transactionDepth -= 1;
      this.#raw.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  close(): void { this.#raw.close(); }
}

export function openDatabase(filePath: string): Database {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const raw = new DatabaseSync(filePath);
  raw.exec("PRAGMA foreign_keys = ON");
  if (filePath !== ":memory:") raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  return new SqliteDatabase(raw);
}
```

- [ ] **Step 4: Add the ordered version-1 schema migration**

`runMigrations` first creates `schema_migrations`, reads applied versions, and runs each missing migration through `database.transaction`. Migration 1 must execute these exact tables and constraints:

```ts
// src/worker/storage/migrations.ts
import type { Database } from "./database";

const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      repository_root TEXT NOT NULL UNIQUE,
      git_common_dir TEXT NOT NULL,
      display_name TEXT NOT NULL,
      head_oid TEXT NOT NULL,
      default_branch TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX rooms_project_created ON rooms(project_id, created_at, id);
    CREATE TABLE room_events (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      room_seq INTEGER NOT NULL CHECK(room_seq > 0),
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL CHECK(actor IN ('user','claude','codex','system')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(room_id, room_seq)
    );
    CREATE INDEX room_events_replay ON room_events(room_id, room_seq);
    CREATE TABLE idempotency_records (
      idempotency_key TEXT PRIMARY KEY,
      request_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      worker_generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
      response_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE worker_leases (
      lease_key INTEGER PRIMARY KEY CHECK(lease_key = 1),
      owner_instance_id TEXT NOT NULL,
      worker_generation TEXT NOT NULL,
      pid INTEGER NOT NULL,
      start_identity TEXT NOT NULL,
      heartbeat_ms INTEGER NOT NULL
    );
  `
}] as const;

export function runMigrations(database: Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const record = database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    if (applied.get(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    });
  }
}
```

- [ ] **Step 5: Verify storage configuration and migration behavior**

Run: `pnpm exec vitest run tests/integration/database.test.ts`

Expected: PASS with 2 tests; the file database reports `wal`, migration count remains 1, and the nested rollback leaves zero rows.

Run: `pnpm typecheck`

Expected: exit 0, including the `StatementSync` interface.

- [ ] **Step 6: Commit**

```bash
git add src/worker/storage/database.ts src/worker/storage/migrations.ts tests/integration/database.test.ts
git commit -m "feat: add sqlite database migrations"
```

### Task 4: Repositories, Event Store, and Durable Idempotency

**Files:**
- Create: `src/worker/storage/repositories.ts`
- Create: `src/worker/storage/event-store.ts`
- Create: `src/worker/storage/idempotency-store.ts`
- Test: `tests/integration/event-store.test.ts`

**Interfaces:**
- Consumes: `Database`, migration-1 tables, and all Task 2 domain schemas.
- Produces: `DomainRepositories`; canonical `EventStore { append, snapshot, after }`; `IdempotencyStore.execute(command, resultSchema, mutation)`; `hashWorkerCommand(command)`; `IdempotencyConflictError`.

- [ ] **Step 1: Write failing tests for per-room sequence, snapshot/replay, duplicate replay, and conflicting keys**

Create an in-memory database, migrate it, insert one Project and two Rooms through `DomainRepositories`, and use fixed UUIDs/timestamps so assertions remain exact:

```ts
// tests/integration/event-store.test.ts
import { describe, expect, it } from "vitest";
import { ProjectSchema } from "../../src/shared/contracts/domain";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import { createIdempotencyStore, IdempotencyConflictError } from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";

describe("event storage", () => {
  it("allocates room_seq per room and replays after a cursor", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repositories = createRepositories(database);
    const project = repositories.projects.insert({ id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" });
    const roomA = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000001", projectId: project.id, title: "A", createdAt: "2026-07-21T10:01:00.000Z" });
    const roomB = repositories.rooms.insert({ id: "20000000-0000-4000-8000-000000000002", projectId: project.id, title: "B", createdAt: "2026-07-21T10:02:00.000Z" });
    const events = createEventStore(database, repositories);
    const first = events.append({ id: "30000000-0000-4000-8000-000000000001", roomId: roomA.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000001", roomId: roomA.id, body: "one", createdAt: "2026-07-21T10:03:00.000Z" }, createdAt: "2026-07-21T10:03:00.000Z" });
    const second = events.append({ id: "30000000-0000-4000-8000-000000000002", roomId: roomA.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000002", roomId: roomA.id, body: "two", createdAt: "2026-07-21T10:04:00.000Z" }, createdAt: "2026-07-21T10:04:00.000Z" });
    const other = events.append({ id: "30000000-0000-4000-8000-000000000003", roomId: roomB.id, type: "message.posted", actor: "user", payload: { id: "40000000-0000-4000-8000-000000000003", roomId: roomB.id, body: "other", createdAt: "2026-07-21T10:05:00.000Z" }, createdAt: "2026-07-21T10:05:00.000Z" });
    expect([first.roomSeq, second.roomSeq, other.roomSeq]).toEqual([1, 2, 1]);
    expect(events.snapshot().roomCursors).toEqual({ [roomA.id]: 2, [roomB.id]: 1 });
    expect(events.after({ roomId: roomA.id, roomSeq: 1, limit: 50 })).toMatchObject({ events: [{ roomSeq: 2 }], nextRoomSeq: 2, hasMore: false });
    database.close();
  });

  it("commits a mutation once and rejects key reuse with a different hash", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const dedupe = createIdempotencyStore(database, () => "2026-07-21T10:00:00.000Z");
    let writes = 0;
    const command = { idempotencyKey: "same-key", requestType: "project.addExisting", requestHash: "hash-a", workerGeneration: "50000000-0000-4000-8000-000000000001" };
    const first = dedupe.execute(command, ProjectSchema, () => { writes += 1; return { id: "10000000-0000-4000-8000-000000000001", repositoryRoot: "/repo", gitCommonDir: "/repo/.git", displayName: "repo", headOid: "a".repeat(40), defaultBranch: "main", createdAt: "2026-07-21T10:00:00.000Z" }; });
    const replay = dedupe.execute(command, ProjectSchema, () => { writes += 1; throw new Error("must not run"); });
    expect({ writes, first: first.replayed, replay: replay.replayed }).toEqual({ writes: 1, first: false, replay: true });
    expect(() => dedupe.execute({ ...command, requestHash: "hash-b" }, ProjectSchema, () => first.value)).toThrow(IdempotencyConflictError);
    database.close();
  });
});
```

- [ ] **Step 2: Run the event-store test to verify it fails**

Run: `pnpm exec vitest run tests/integration/event-store.test.ts`

Expected: FAIL because `createEventStore`, `createRepositories`, and `createIdempotencyStore` are not defined.

- [ ] **Step 3: Implement focused Project and Room repositories**

`src/worker/storage/repositories.ts` must export these exact interfaces and factory:

```ts
import type { Project, Room } from "../../shared/contracts/domain";
import { ProjectSchema, RoomSchema } from "../../shared/contracts/domain";
import type { Database } from "./database";

export interface ProjectRepository {
  insert(project: Project): Project;
  findByRepositoryRoot(repositoryRoot: string): Project | undefined;
  findById(id: string): Project | undefined;
  list(): Project[];
}
export interface RoomRepository {
  insert(room: Room): Room;
  findById(id: string): Room | undefined;
  list(): Room[];
}
export interface DomainRepositories { projects: ProjectRepository; rooms: RoomRepository; }
```

Implement the declared factory in the same file. Prepare `INSERT INTO projects(id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, Project lookup by `repository_root`, Project lookup by `id`, and Project list ordered by `created_at, id`. Prepare `INSERT INTO rooms(id, project_id, title, created_at) VALUES (?, ?, ?, ?)`, Room lookup by `id`, and Room list ordered by `created_at, id`. Use these concrete row mappers for every query result; no raw SQLite row crosses the repository seam:

```ts
interface ProjectRow { id: string; repository_root: string; git_common_dir: string; display_name: string; head_oid: string; default_branch: string | null; created_at: string; }
interface RoomRow { id: string; project_id: string; title: string; created_at: string; }
const mapProject = (row: ProjectRow): Project => ProjectSchema.parse({ id: row.id, repositoryRoot: row.repository_root, gitCommonDir: row.git_common_dir, displayName: row.display_name, headOid: row.head_oid, defaultBranch: row.default_branch, createdAt: row.created_at });
const mapRoom = (row: RoomRow): Room => RoomSchema.parse({ id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at });

export function createRepositories(database: Database): DomainRepositories {
  const projectColumns = "id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at";
  const roomColumns = "id, project_id, title, created_at";
  const insertProject = database.prepare("INSERT INTO projects(id, repository_root, git_common_dir, display_name, head_oid, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insertRoom = database.prepare("INSERT INTO rooms(id, project_id, title, created_at) VALUES (?, ?, ?, ?)");
  return {
    projects: {
      insert(input) {
        const project = ProjectSchema.parse(input);
        insertProject.run(project.id, project.repositoryRoot, project.gitCommonDir, project.displayName, project.headOid, project.defaultBranch, project.createdAt);
        return project;
      },
      findByRepositoryRoot(repositoryRoot) {
        const row = database.prepare(`SELECT ${projectColumns} FROM projects WHERE repository_root = ?`).get(repositoryRoot) as ProjectRow | undefined;
        return row ? mapProject(row) : undefined;
      },
      findById(id) {
        const row = database.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
        return row ? mapProject(row) : undefined;
      },
      list() {
        return (database.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at, id`).all() as ProjectRow[]).map(mapProject);
      }
    },
    rooms: {
      insert(input) {
        const room = RoomSchema.parse(input);
        insertRoom.run(room.id, room.projectId, room.title, room.createdAt);
        return room;
      },
      findById(id) {
        const row = database.prepare(`SELECT ${roomColumns} FROM rooms WHERE id = ?`).get(id) as RoomRow | undefined;
        return row ? mapRoom(row) : undefined;
      },
      list() {
        return (database.prepare(`SELECT ${roomColumns} FROM rooms ORDER BY created_at, id`).all() as RoomRow[]).map(mapRoom);
      }
    }
  };
}
```

Each `insert` first parses its input, executes its prepared statement, and returns the parsed value. Each `find` returns `undefined` for no row; each `list` maps all rows in SQL order. This provides a complete `DomainRepositories` object with no transaction policy of its own.

- [ ] **Step 4: Implement the canonical EventStore methods**

```ts
// src/worker/storage/event-store.ts
import type { AppSnapshot, RoomEvent, RoomEventCursor, RoomEventPage, UserMessage } from "../../shared/contracts/domain";
import { AppSnapshotSchema, RoomEventPageSchema, RoomEventSchema } from "../../shared/contracts/domain";
import type { Database } from "./database";
import type { DomainRepositories } from "./repositories";

export interface AppendRoomEventInput {
  id: string;
  roomId: string;
  type: "message.posted";
  actor: "user" | "claude" | "codex" | "system";
  payload: UserMessage;
  createdAt: string;
}
export interface EventStore {
  append(input: AppendRoomEventInput): RoomEvent;
  snapshot(): AppSnapshot;
  after(cursor: RoomEventCursor): RoomEventPage;
}

export function createEventStore(database: Database, repositories: DomainRepositories): EventStore {
  return {
    append(input) {
      return database.transaction(() => {
        if (!repositories.rooms.findById(input.roomId)) throw new Error(`Room not found: ${input.roomId}`);
        const row = database.prepare("SELECT COALESCE(MAX(room_seq), 0) + 1 AS next_seq FROM room_events WHERE room_id = ?").get(input.roomId) as { next_seq: number };
        const event = RoomEventSchema.parse({ ...input, roomSeq: row.next_seq });
        database.prepare("INSERT INTO room_events(id, room_id, room_seq, event_type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, event.roomId, event.roomSeq, event.type, event.actor, JSON.stringify(event.payload), event.createdAt);
        return event;
      });
    },
    snapshot() {
      const cursorRows = database.prepare("SELECT room_id, MAX(room_seq) AS room_seq FROM room_events GROUP BY room_id").all() as Array<{ room_id: string; room_seq: number }>;
      const roomCursors = Object.fromEntries(repositories.rooms.list().map((room) => [room.id, 0]));
      for (const row of cursorRows) roomCursors[row.room_id] = row.room_seq;
      return AppSnapshotSchema.parse({ projects: repositories.projects.list(), rooms: repositories.rooms.list(), roomCursors });
    },
    after(cursor) {
      const rows = database.prepare("SELECT id, room_id, room_seq, event_type, actor, payload_json, created_at FROM room_events WHERE room_id = ? AND room_seq > ? ORDER BY room_seq LIMIT ?").all(cursor.roomId, cursor.roomSeq, cursor.limit + 1) as Array<{ id: string; room_id: string; room_seq: number; event_type: string; actor: string; payload_json: string; created_at: string }>;
      const hasMore = rows.length > cursor.limit;
      const events = rows.slice(0, cursor.limit).map((row) => RoomEventSchema.parse({ id: row.id, roomId: row.room_id, roomSeq: row.room_seq, type: row.event_type, actor: row.actor, payload: JSON.parse(String(row.payload_json)), createdAt: row.created_at }));
      const nextRoomSeq = events.at(-1)?.roomSeq ?? cursor.roomSeq;
      return RoomEventPageSchema.parse({ roomId: cursor.roomId, events, nextRoomSeq, hasMore });
    }
  };
}
```

- [ ] **Step 5: Implement durable command response dedupe**

```ts
// src/worker/storage/idempotency-store.ts
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { WorkerCommand } from "../../shared/contracts/protocol";
import type { Database } from "./database";

export interface DurableCommand {
  idempotencyKey: string;
  requestType: string;
  requestHash: string;
  workerGeneration: string;
}
export interface DurableResult<T> { value: T; replayed: boolean; }
export class IdempotencyConflictError extends Error {}
export interface IdempotencyStore {
  execute<T>(command: DurableCommand, resultSchema: ZodType<T>, mutation: () => T): DurableResult<T>;
}

export function hashWorkerCommand(command: WorkerCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

export function createIdempotencyStore(database: Database, now: () => string): IdempotencyStore {
  return {
    execute(command, resultSchema, mutation) {
      return database.transaction(() => {
        const existing = database.prepare("SELECT request_type, request_hash, status, response_json FROM idempotency_records WHERE idempotency_key = ?").get(command.idempotencyKey) as { request_type: string; request_hash: string; status: string; response_json: string | null } | undefined;
        if (existing) {
          if (existing.request_type !== command.requestType || existing.request_hash !== command.requestHash) throw new IdempotencyConflictError(`Idempotency key conflict: ${command.idempotencyKey}`);
          if (existing.status !== "completed" || existing.response_json === null) throw new Error(`Incomplete idempotency record: ${command.idempotencyKey}`);
          return { value: resultSchema.parse(JSON.parse(existing.response_json)), replayed: true };
        }
        const createdAt = now();
        database.prepare("INSERT INTO idempotency_records(idempotency_key, request_type, request_hash, worker_generation, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)").run(command.idempotencyKey, command.requestType, command.requestHash, command.workerGeneration, createdAt);
        const value = resultSchema.parse(mutation());
        database.prepare("UPDATE idempotency_records SET status = 'completed', response_json = ?, completed_at = ? WHERE idempotency_key = ?").run(JSON.stringify(value), now(), command.idempotencyKey);
        return { value, replayed: false };
      });
    }
  };
}
```

Because the insert, nested EventStore append, saved response, and outer commit are synchronous, the caller cannot construct an ACK before the durable transaction returns.

- [ ] **Step 6: Verify event ordering and dedupe behavior**

Run: `pnpm exec vitest run tests/integration/event-store.test.ts`

Expected: PASS with 2 tests; sequences are `[1, 2, 1]`, replay begins after cursor 1, and the duplicate mutation performs one write.

Run: `pnpm typecheck`

Expected: exit 0 with the exact `Database`, `EventStore`, and repository interfaces.

- [ ] **Step 7: Commit**

```bash
git add src/worker/storage/repositories.ts src/worker/storage/event-store.ts src/worker/storage/idempotency-store.ts tests/integration/event-store.test.ts
git commit -m "feat: persist room events with durable dedupe"
```

### Task 5: No-Shell Git Repository Inspection

**Files:**
- Create: `src/worker/process/exec-file.ts`
- Create: `src/worker/git/inspect-repository.ts`
- Create: `tests/fixtures/git-repository.ts`
- Test: `tests/unit/inspect-repository.test.ts`
- Test: `tests/integration/inspect-repository.test.ts`

**Interfaces:**
- Consumes: Worker ownership boundary; no Renderer or Main filesystem input beyond the Main-resolved directory command.
- Produces: `ExecFileRunner(executable, args, options)`; production `execFileNoShell`; `RepositoryInspection`; `inspectExistingRepository(selectedPath, dependencies)`; `GitRepositoryError`.

- [ ] **Step 1: Write a failing unit test that fixes the argv-only Git contract**

```ts
// tests/unit/inspect-repository.test.ts
import { describe, expect, it } from "vitest";
import { inspectExistingRepository } from "../../src/worker/git/inspect-repository";
import type { ExecFileRunner } from "../../src/worker/process/exec-file";

describe("inspectExistingRepository", () => {
  it("canonicalizes root/common dir and invokes absolute Git with argv", async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const outputs = ["/canonical/repo\n", "/canonical/repo/.git\n", `${"a".repeat(40)}\n`, "main\n"];
    const execFile: ExecFileRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    };
    const result = await inspectExistingRepository("/chosen/subdir", {
      execFile,
      realpath: async (path) => path === "/chosen/subdir" ? "/canonical/chosen" : path,
      gitExecutable: "/usr/bin/git"
    });
    expect(result).toEqual({ repositoryRoot: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", headOid: "a".repeat(40), defaultBranch: "main" });
    expect(calls).toEqual([
      { executable: "/usr/bin/git", args: ["-C", "/canonical/chosen", "rev-parse", "--path-format=absolute", "--show-toplevel"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--path-format=absolute", "--git-common-dir"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--verify", "HEAD^{commit}"] },
      { executable: "/usr/bin/git", args: ["-C", "/canonical/repo", "rev-parse", "--abbrev-ref", "HEAD"] }
    ]);
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `pnpm exec vitest run tests/unit/inspect-repository.test.ts`

Expected: FAIL because `src/worker/git/inspect-repository.ts` does not exist.

- [ ] **Step 3: Implement the bounded `execFile` adapter with shell permanently disabled**

```ts
// src/worker/process/exec-file.ts
import { execFile } from "node:child_process";

export interface ExecFileOptions {
  cwd?: string;
  timeoutMs: number;
  maxBufferBytes: number;
}
export interface ExecFileResult { stdout: string; stderr: string; }
export type ExecFileRunner = (executable: string, args: readonly string[], options: ExecFileOptions) => Promise<ExecFileResult>;

export const execFileNoShell: ExecFileRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    windowsHide: true,
    shell: false
  }, (error, stdout, stderr) => {
    if (error) {
      reject(Object.assign(new Error(`Executable failed: ${executable}`), { cause: error, stderr }));
      return;
    }
    resolve({ stdout, stderr });
  });
});
```

- [ ] **Step 4: Implement canonical root, common-dir, HEAD, and branch inspection**

```ts
// src/worker/git/inspect-repository.ts
import { realpath as nodeRealpath } from "node:fs/promises";
import { execFileNoShell, type ExecFileRunner } from "../process/exec-file";

export interface RepositoryInspection {
  repositoryRoot: string;
  gitCommonDir: string;
  headOid: string;
  defaultBranch: string | null;
}
export interface RepositoryInspectorDependencies {
  execFile: ExecFileRunner;
  realpath(path: string): Promise<string>;
  gitExecutable: string;
}
export class GitRepositoryError extends Error {}

const productionDependencies: RepositoryInspectorDependencies = {
  execFile: execFileNoShell,
  realpath: nodeRealpath,
  gitExecutable: "/usr/bin/git"
};

export async function inspectExistingRepository(selectedPath: string, dependencies: RepositoryInspectorDependencies = productionDependencies): Promise<RepositoryInspection> {
  try {
    const selected = await dependencies.realpath(selectedPath);
    const run = async (args: readonly string[]): Promise<string> => (await dependencies.execFile(dependencies.gitExecutable, args, { timeoutMs: 5_000, maxBufferBytes: 1_048_576 })).stdout.trim();
    const repositoryRootOutput = await run(["-C", selected, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
    const repositoryRoot = await dependencies.realpath(repositoryRootOutput);
    const gitCommonDirOutput = await run(["-C", repositoryRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitCommonDir = await dependencies.realpath(gitCommonDirOutput);
    const headOid = await run(["-C", repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = await run(["-C", repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(headOid)) throw new Error("HEAD is not a commit OID");
    return { repositoryRoot, gitCommonDir, headOid, defaultBranch: branch === "HEAD" ? null : branch };
  } catch (error) {
    throw new GitRepositoryError(`Selected directory is not a Git repository with a valid HEAD`, { cause: error });
  }
}
```

- [ ] **Step 5: Verify the unit argv contract**

Run: `pnpm exec vitest run tests/unit/inspect-repository.test.ts`

Expected: PASS with 1 test and four exact `/usr/bin/git` argv calls; no command is a shell string.

- [ ] **Step 6: Add a real temporary-repository fixture and integration test**

`tests/fixtures/git-repository.ts` must use `mkdtempSync`, `writeFileSync`, and Node `execFileSync` with argv to initialize a repository, set commit-local identity through `git -c user.name=Branchestra -c user.email=branchestra@invalid`, add one file, and make a `--no-gpg-sign` initial commit. Export `{ root, cleanup }`; `cleanup()` removes only that generated temp root.

```ts
// tests/integration/inspect-repository.test.ts
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../fixtures/git-repository";
import { inspectExistingRepository } from "../../src/worker/git/inspect-repository";

describe("real Git repository inspection", () => {
  it("accepts a subdirectory and returns canonical repository facts", async () => {
    const fixture = createGitRepository();
    try {
      const result = await inspectExistingRepository(join(fixture.root, "nested"));
      expect(result.repositoryRoot).toBe(realpathSync(fixture.root));
      expect(result.gitCommonDir).toBe(realpathSync(join(fixture.root, ".git")));
      expect(result.headOid).toMatch(/^[0-9a-f]{40,64}$/);
      expect(result.defaultBranch).toBe("main");
    } finally { fixture.cleanup(); }
  });
});
```

The fixture creates the `nested` directory before returning.

- [ ] **Step 7: Run Git integration and type checks**

Run: `pnpm exec vitest run tests/integration/inspect-repository.test.ts`

Expected: PASS with 1 test against a real repository with a valid `HEAD`.

Run: `pnpm typecheck`

Expected: exit 0; `ExecFileRunner` remains the only executable abstraction exported to later worker code.

- [ ] **Step 8: Commit**

```bash
git add src/worker/process/exec-file.ts src/worker/git/inspect-repository.ts tests/fixtures/git-repository.ts tests/unit/inspect-repository.test.ts tests/integration/inspect-repository.test.ts
git commit -m "feat: validate existing Git repositories"
```

### Task 6: Project, Multi-Room, and Local-Message Domain Services

**Files:**
- Create: `src/worker/domain/project-service.ts`
- Create: `src/worker/domain/room-service.ts`
- Test: `tests/integration/domain-services.test.ts`

**Interfaces:**
- Consumes: repository inspection, repositories, `EventStore`, `IdempotencyStore`, and Task 2 schemas.
- Produces: `ProjectService.addExistingProject(input, metadata): Promise<DurableResult<Project>>`; `RoomService.createRoom`, `postUserMessage`, `getSnapshot`, and `replayRoom`; injectable `Clock` and `IdGenerator`.

- [ ] **Step 1: Write a failing vertical domain test for one project, two rooms, isolated messages, and duplicate commands**

```ts
// tests/integration/domain-services.test.ts
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/worker/storage/database";
import { createEventStore } from "../../src/worker/storage/event-store";
import { createIdempotencyStore } from "../../src/worker/storage/idempotency-store";
import { runMigrations } from "../../src/worker/storage/migrations";
import { createRepositories } from "../../src/worker/storage/repositories";
import { createProjectService } from "../../src/worker/domain/project-service";
import { createRoomService } from "../../src/worker/domain/room-service";

describe("foundation domain services", () => {
  it("persists a validated project, multiple rooms, and room-local messages", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repositories = createRepositories(database);
    const events = createEventStore(database, repositories);
    const dedupe = createIdempotencyStore(database, () => "2026-07-21T12:00:00.000Z");
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "30000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000001"
    ];
    const common = {
      repositories,
      eventStore: events,
      idempotencyStore: dedupe,
      clock: { now: () => "2026-07-21T12:00:00.000Z" },
      ids: { next: () => ids.shift() ?? (() => { throw new Error("ID exhausted"); })() },
    };
    const projects = createProjectService({ ...common, inspectRepository: async () => ({ repositoryRoot: "/repo", gitCommonDir: "/repo/.git", headOid: "a".repeat(40), defaultBranch: "main" }) });
    const rooms = createRoomService(common);
    const metadata = (key: string, type: string) => ({ idempotencyKey: key, requestType: type, requestHash: `${key}-hash`, workerGeneration: "50000000-0000-4000-8000-000000000001" });
    const project = (await projects.addExistingProject({ selectedPath: "/chosen" }, metadata("project-1", "project.addExisting"))).value;
    const roomA = rooms.createRoom({ projectId: project.id, title: "Architecture" }, metadata("room-a", "room.create")).value;
    const roomB = rooms.createRoom({ projectId: project.id, title: "UX" }, metadata("room-b", "room.create")).value;
    const first = rooms.postUserMessage({ roomId: roomA.id, body: "Persist this" }, metadata("message-a", "message.post"));
    const replayed = rooms.postUserMessage({ roomId: roomA.id, body: "Persist this" }, metadata("message-a", "message.post"));
    expect(replayed).toMatchObject({ replayed: true, value: { id: first.value.id, roomSeq: 1 } });
    expect(rooms.replayRoom({ roomId: roomA.id, roomSeq: 0, limit: 100 }).events.map((event) => event.payload.body)).toEqual(["Persist this"]);
    expect(rooms.replayRoom({ roomId: roomB.id, roomSeq: 0, limit: 100 }).events).toEqual([]);
    expect(rooms.getSnapshot()).toMatchObject({ projects: [{ id: project.id }], rooms: [{ id: roomA.id }, { id: roomB.id }] });
    database.close();
  });
});
```

- [ ] **Step 2: Run the domain test to verify it fails**

Run: `pnpm exec vitest run tests/integration/domain-services.test.ts`

Expected: FAIL because the Project and Room service factories do not exist.

- [ ] **Step 3: Implement Add Existing Project after Git validation**

```ts
// src/worker/domain/project-service.ts
import { basename } from "node:path";
import type { Clock, IdGenerator, Project } from "../../shared/contracts/domain";
import { ProjectSchema } from "../../shared/contracts/domain";
import type { RepositoryInspection } from "../git/inspect-repository";
import type { DurableCommand, DurableResult, IdempotencyStore } from "../storage/idempotency-store";
import type { DomainRepositories } from "../storage/repositories";

export interface ProjectServiceDependencies {
  repositories: DomainRepositories;
  idempotencyStore: IdempotencyStore;
  inspectRepository(path: string): Promise<RepositoryInspection>;
  clock: Clock;
  ids: IdGenerator;
}
export interface ProjectService {
  addExistingProject(input: { selectedPath: string }, metadata: DurableCommand): Promise<DurableResult<Project>>;
}

export function createProjectService(dependencies: ProjectServiceDependencies): ProjectService {
  return {
    async addExistingProject(input, metadata) {
      const inspection = await dependencies.inspectRepository(input.selectedPath);
      return dependencies.idempotencyStore.execute(metadata, ProjectSchema, () => {
        const existing = dependencies.repositories.projects.findByRepositoryRoot(inspection.repositoryRoot);
        if (existing) return existing;
        return dependencies.repositories.projects.insert(ProjectSchema.parse({ id: dependencies.ids.next(), ...inspection, displayName: basename(inspection.repositoryRoot), createdAt: dependencies.clock.now() }));
      });
    }
  };
}
```

- [ ] **Step 4: Implement room creation, local message append, snapshot, and replay**

```ts
// src/worker/domain/room-service.ts
import type { AppSnapshot, Clock, IdGenerator, Room, RoomEvent, RoomEventCursor, RoomEventPage } from "../../shared/contracts/domain";
import { RoomEventSchema, RoomSchema } from "../../shared/contracts/domain";
import type { EventStore } from "../storage/event-store";
import type { DurableCommand, DurableResult, IdempotencyStore } from "../storage/idempotency-store";
import type { DomainRepositories } from "../storage/repositories";

export interface RoomServiceDependencies { repositories: DomainRepositories; eventStore: EventStore; idempotencyStore: IdempotencyStore; clock: Clock; ids: IdGenerator; }
export interface RoomService {
  createRoom(input: { projectId: string; title: string }, metadata: DurableCommand): DurableResult<Room>;
  postUserMessage(input: { roomId: string; body: string }, metadata: DurableCommand): DurableResult<RoomEvent>;
  getSnapshot(): AppSnapshot;
  replayRoom(cursor: RoomEventCursor): RoomEventPage;
}

export function createRoomService(dependencies: RoomServiceDependencies): RoomService {
  return {
    createRoom(input, metadata) {
      return dependencies.idempotencyStore.execute(metadata, RoomSchema, () => {
        if (!dependencies.repositories.projects.findById(input.projectId)) throw new Error(`Project not found: ${input.projectId}`);
        return dependencies.repositories.rooms.insert(RoomSchema.parse({ id: dependencies.ids.next(), projectId: input.projectId, title: input.title, createdAt: dependencies.clock.now() }));
      });
    },
    postUserMessage(input, metadata) {
      return dependencies.idempotencyStore.execute(metadata, RoomEventSchema, () => {
        const createdAt = dependencies.clock.now();
        const messageId = dependencies.ids.next();
        return dependencies.eventStore.append({ id: dependencies.ids.next(), roomId: input.roomId, type: "message.posted", actor: "user", payload: { id: messageId, roomId: input.roomId, body: input.body, createdAt }, createdAt });
      });
    },
    getSnapshot: () => dependencies.eventStore.snapshot(),
    replayRoom: (cursor) => dependencies.eventStore.after(cursor)
  };
}
```

- [ ] **Step 5: Verify the domain vertical slice**

Run: `pnpm exec vitest run tests/integration/domain-services.test.ts`

Expected: PASS with 1 test; Room A has one committed event at sequence 1, Room B is empty, and replay of the same command does not append again.

Run: `pnpm typecheck`

Expected: exit 0 with Project service async only around Git inspection and all SQLite transaction callbacks synchronous.

- [ ] **Step 6: Commit**

```bash
git add src/worker/domain/project-service.ts src/worker/domain/room-service.ts tests/integration/domain-services.test.ts
git commit -m "feat: add project room and message services"
```

### Task 7: Canonical Command Handlers and Generation-Aware Worker Router

**Files:**
- Create: `src/worker/protocol/command-handler.ts`
- Create: `src/worker/protocol/handlers.ts`
- Create: `src/worker/protocol/worker-router.ts`
- Test: `tests/unit/worker-router.test.ts`

**Interfaces:**
- Consumes: `WorkerCommand`, `WorkerRequestEnvelope`, `WorkerResponseEnvelope`, Project service, and Room service.
- Produces: canonical `CommandHandler<TType>.handle(command, context)`; `CommandContext`; `createCommandHandlers(services)`; `createWorkerRouter({ workerGeneration, handlers })`.

- [ ] **Step 1: Write failing tests proving stale generations never dispatch and current generations preserve response correlation**

```ts
// tests/unit/worker-router.test.ts
import { describe, expect, it, vi } from "vitest";
import type { CommandHandler } from "../../src/worker/protocol/command-handler";
import { createWorkerRouter } from "../../src/worker/protocol/worker-router";

const activeGeneration = "50000000-0000-4000-8000-000000000001";
const request = {
  v: 1,
  requestId: "10000000-0000-4000-8000-000000000001",
  idempotencyKey: "snapshot-1",
  workerGeneration: activeGeneration,
  type: "state.getSnapshot",
  payload: {}
} as const;

describe("worker router", () => {
  it("rejects a stale generation before invoking a handler", async () => {
    const handle = vi.fn(() => ({ data: { projects: [], rooms: [], roomCursors: {} }, replayed: false }));
    const handler: CommandHandler<"state.getSnapshot"> = { type: "state.getSnapshot", handle };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route({ ...request, workerGeneration: "50000000-0000-4000-8000-000000000002" });
    expect(handle).not.toHaveBeenCalled();
    expect(response).toMatchObject({ requestId: request.requestId, workerGeneration: activeGeneration, payload: { ok: false, code: "STALE_WORKER_GENERATION" } });
  });

  it("dispatches the exact command and echoes request correlation", async () => {
    const handler: CommandHandler<"state.getSnapshot"> = {
      type: "state.getSnapshot",
      handle: vi.fn(() => ({ data: { projects: [], rooms: [], roomCursors: {} }, replayed: false }))
    };
    const route = createWorkerRouter({ workerGeneration: activeGeneration, handlers: [handler] });
    const response = await route(request);
    expect(handler.handle).toHaveBeenCalledWith({ type: request.type, payload: request.payload }, expect.objectContaining({ requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration }));
    expect(response).toMatchObject({ v: 1, requestId: request.requestId, idempotencyKey: request.idempotencyKey, workerGeneration: activeGeneration, type: "response", payload: { ok: true, requestType: "state.getSnapshot", replayed: false } });
  });
});
```

- [ ] **Step 2: Run the router test to verify it fails**

Run: `pnpm exec vitest run tests/unit/worker-router.test.ts`

Expected: FAIL because `CommandHandler` and `createWorkerRouter` do not exist.

- [ ] **Step 3: Define the exact handler seam and context metadata**

```ts
// src/worker/protocol/command-handler.ts
import type { WorkerCommand, WorkerResponsePayload } from "../../shared/contracts/protocol";
import type { DurableCommand } from "../storage/idempotency-store";
import { hashWorkerCommand } from "../storage/idempotency-store";

type SuccessPayload = Extract<WorkerResponsePayload, { ok: true }>;
export interface HandlerResult { data: SuccessPayload["data"]; replayed: boolean; }
export interface CommandContext {
  requestId: string;
  idempotencyKey: string;
  workerGeneration: string;
  durable(command: WorkerCommand): DurableCommand;
}
export interface CommandHandler<TType extends WorkerCommand["type"] = WorkerCommand["type"]> {
  readonly type: TType;
  handle(command: Extract<WorkerCommand, { type: TType }>, context: CommandContext): Promise<HandlerResult> | HandlerResult;
}
export type AnyCommandHandler = {
  [TType in WorkerCommand["type"]]: CommandHandler<TType>
}[WorkerCommand["type"]];

export function createCommandContext(input: { requestId: string; idempotencyKey: string; workerGeneration: string }): CommandContext {
  return {
    ...input,
    durable: (command) => ({
      idempotencyKey: input.idempotencyKey,
      requestType: command.type,
      requestHash: hashWorkerCommand(command),
      workerGeneration: input.workerGeneration
    })
  };
}
```

- [ ] **Step 4: Implement one explicit handler for every Worker command**

`src/worker/protocol/handlers.ts` exports `createCommandHandlers` with dependencies `{ projectService, roomService, prepareQuit(deadlineMs): Promise<void> }`. Return these six typed handlers; each mutation passes `context.durable(command)` into its domain service:

```ts
return [
  { type: "state.getSnapshot", handle: () => ({ data: services.roomService.getSnapshot(), replayed: false }) },
  { type: "room.replay", handle: (command) => ({ data: services.roomService.replayRoom(command.payload), replayed: false }) },
  { type: "project.addExisting", handle: async (command, context) => {
      const result = await services.projectService.addExistingProject(command.payload, context.durable(command));
      return { data: result.value, replayed: result.replayed };
    } },
  { type: "room.create", handle: (command, context) => {
      const result = services.roomService.createRoom(command.payload, context.durable(command));
      return { data: result.value, replayed: result.replayed };
    } },
  { type: "message.post", handle: (command, context) => {
      const result = services.roomService.postUserMessage(command.payload, context.durable(command));
      return { data: result.value, replayed: result.replayed };
    } },
  { type: "worker.prepareQuit", handle: async (command) => {
      await services.prepareQuit(command.payload.deadlineMs);
      return { data: { prepared: true as const }, replayed: false };
    } }
] satisfies readonly AnyCommandHandler[];
```

There is no catch-all command handler. Adding a later command requires extending the Zod union and this exhaustive list in the same commit.

- [ ] **Step 5: Implement routing, exact generation rejection, and stable error mapping**

```ts
// src/worker/protocol/worker-router.ts
import { WorkerResponseEnvelopeSchema, type WorkerCommand, type WorkerRequestEnvelope, type WorkerResponseEnvelope } from "../../shared/contracts/protocol";
import { GitRepositoryError } from "../git/inspect-repository";
import { IdempotencyConflictError } from "../storage/idempotency-store";
import { createCommandContext, type AnyCommandHandler, type CommandContext, type HandlerResult } from "./command-handler";

export function createWorkerRouter(options: { workerGeneration: string; handlers: readonly AnyCommandHandler[] }): (envelope: WorkerRequestEnvelope) => Promise<WorkerResponseEnvelope> {
  const handlers = new Map(options.handlers.map((handler) => [handler.type, handler]));
  return async (envelope) => {
    const fail = (code: "STALE_WORKER_GENERATION" | "IDEMPOTENCY_CONFLICT" | "GIT_INVALID" | "NOT_FOUND" | "INTERNAL", message: string) => WorkerResponseEnvelopeSchema.parse({ v: 1, requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey, workerGeneration: options.workerGeneration, type: "response", payload: { ok: false, requestType: envelope.type, code, message } });
    if (envelope.workerGeneration !== options.workerGeneration) return fail("STALE_WORKER_GENERATION", "Worker generation changed; refresh snapshot before retrying");
    const handler = handlers.get(envelope.type);
    if (!handler) return fail("INTERNAL", `No worker handler registered for ${envelope.type}`);
    try {
      const command = { type: envelope.type, payload: envelope.payload } as WorkerCommand;
      const invoke = handler.handle as (command: WorkerCommand, context: CommandContext) => Promise<HandlerResult> | HandlerResult;
      const result = await invoke(command, createCommandContext(envelope));
      return WorkerResponseEnvelopeSchema.parse({ v: 1, requestId: envelope.requestId, idempotencyKey: envelope.idempotencyKey, workerGeneration: options.workerGeneration, type: "response", payload: { ok: true, requestType: envelope.type, data: result.data, replayed: result.replayed } });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return fail("IDEMPOTENCY_CONFLICT", error.message);
      if (error instanceof GitRepositoryError) return fail("GIT_INVALID", error.message);
      if (error instanceof Error && error.message.includes("not found")) return fail("NOT_FOUND", error.message);
      return fail("INTERNAL", "Worker command failed");
    }
  };
}
```

The implementation should use a narrow internal type assertion at the Map lookup only; callers and individual handlers remain fully discriminated.

- [ ] **Step 6: Verify router behavior and all earlier worker tests**

Run: `pnpm exec vitest run tests/unit/worker-router.test.ts tests/integration/domain-services.test.ts`

Expected: PASS with 3 tests; stale dispatch count is zero and successful responses preserve all correlation fields.

Run: `pnpm typecheck`

Expected: exit 0 with the exported generic `CommandHandler<TType>` signature.

- [ ] **Step 7: Commit**

```bash
git add src/worker/protocol/command-handler.ts src/worker/protocol/handlers.ts src/worker/protocol/worker-router.ts tests/unit/worker-router.test.ts
git commit -m "feat: route generation-bound worker commands"
```

### Task 8: Exclusive Worker Lease and Utility Runtime Handshake

**Files:**
- Modify: `electron.vite.config.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Create: `src/worker/storage/worker-lease-store.ts`
- Create: `src/worker/runtime.ts`
- Create: `src/worker/index.ts`
- Test: `tests/integration/worker-runtime.test.ts`

**Interfaces:**
- Consumes: migration-1 `worker_leases`, all worker services/handlers, and versioned envelopes.
- Produces: `WorkerLeaseStore.acquire/heartbeat/release`; `WorkerPort`; `WorkerStartOptions`; `WorkerRuntime.prepareQuit`; `startWorker(options): Promise<WorkerRuntime>`; `worker.ready` or `worker.rejected` generation handshake.

- [ ] **Step 1: Write a failing integration test proving a second live owner is rejected and a released owner can be replaced**

```ts
// tests/integration/worker-runtime.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startWorker, type WorkerPort } from "../../src/worker/runtime";

function fakePort(): WorkerPort & { sent: unknown[] } {
  const listeners = new Set<(value: unknown) => void>();
  return {
    sent: [],
    postMessage(value) { this.sent.push(value); },
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

describe("worker runtime lease", () => {
  it("announces only one ready owner for a database", async () => {
    const root = mkdtempSync(join(tmpdir(), "branchestra-worker-"));
    const dbPath = join(root, "branchestra.sqlite3");
    const firstPort = fakePort();
    const secondPort = fakePort();
    const first = await startWorker({ dbPath, port: firstPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000001", workerGeneration: "50000000-0000-4000-8000-000000000001", pid: 101, startIdentity: "101:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
    const second = await startWorker({ dbPath, port: secondPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000002", workerGeneration: "50000000-0000-4000-8000-000000000002", pid: 102, startIdentity: "102:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
    expect(firstPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000001" }));
    expect(secondPort.sent).toContainEqual(expect.objectContaining({ type: "worker.rejected", payload: { code: "LEASE_HELD" } }));
    await first.prepareQuit(Date.now() + 1_000);
    await second.prepareQuit(Date.now() + 1_000);
    const thirdPort = fakePort();
    const third = await startWorker({ dbPath, port: thirdPort, identity: { ownerInstanceId: "60000000-0000-4000-8000-000000000002", workerGeneration: "50000000-0000-4000-8000-000000000003", pid: 103, startIdentity: "103:1" }, leaseTtlMs: 5_000, heartbeatIntervalMs: 1_000 });
    expect(thirdPort.sent).toContainEqual(expect.objectContaining({ type: "worker.ready", workerGeneration: "50000000-0000-4000-8000-000000000003" }));
    await third.prepareQuit(Date.now() + 1_000);
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run: `pnpm exec vitest run tests/integration/worker-runtime.test.ts`

Expected: FAIL because `src/worker/runtime.ts` does not exist.

- [ ] **Step 3: Extend the Worker event contract with an explicit lease rejection**

Add this strict branch to `WorkerEventEnvelopeSchema`; it retains all six envelope metadata fields:

```ts
z.object({
  ...base,
  type: z.literal("worker.rejected"),
  payload: z.object({ code: z.literal("LEASE_HELD") }).strict()
}).strict()
```

- [ ] **Step 4: Implement transactional lease acquisition, exact-identity heartbeats, and release**

```ts
// src/worker/storage/worker-lease-store.ts
import type { Database } from "./database";

export interface WorkerIdentity { ownerInstanceId: string; workerGeneration: string; pid: number; startIdentity: string; }
export interface WorkerLeaseStore {
  acquire(identity: WorkerIdentity, nowMs: number, ttlMs: number): "acquired" | "held";
  heartbeat(identity: WorkerIdentity, nowMs: number): boolean;
  release(identity: WorkerIdentity): void;
}

export function createWorkerLeaseStore(database: Database): WorkerLeaseStore {
  return {
    acquire(identity, nowMs, ttlMs) {
      return database.transaction(() => {
        const current = database.prepare("SELECT owner_instance_id, worker_generation, pid, start_identity, heartbeat_ms FROM worker_leases WHERE lease_key = 1").get() as { owner_instance_id: string; worker_generation: string; pid: number; start_identity: string; heartbeat_ms: number } | undefined;
        const same = current?.owner_instance_id === identity.ownerInstanceId && current.worker_generation === identity.workerGeneration && current.pid === identity.pid && current.start_identity === identity.startIdentity;
        if (current && current.heartbeat_ms > nowMs - ttlMs && !same) return "held";
        database.prepare("INSERT INTO worker_leases(lease_key, owner_instance_id, worker_generation, pid, start_identity, heartbeat_ms) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(lease_key) DO UPDATE SET owner_instance_id=excluded.owner_instance_id, worker_generation=excluded.worker_generation, pid=excluded.pid, start_identity=excluded.start_identity, heartbeat_ms=excluded.heartbeat_ms").run(identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity, nowMs);
        return "acquired";
      });
    },
    heartbeat(identity, nowMs) {
      const result = database.prepare("UPDATE worker_leases SET heartbeat_ms = ? WHERE lease_key = 1 AND owner_instance_id = ? AND worker_generation = ? AND pid = ? AND start_identity = ?").run(nowMs, identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity);
      return Number(result.changes) === 1;
    },
    release(identity) {
      database.prepare("DELETE FROM worker_leases WHERE lease_key = 1 AND owner_instance_id = ? AND worker_generation = ? AND pid = ? AND start_identity = ?").run(identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity);
    }
  };
}
```

- [ ] **Step 5: Compose the sole-owner worker only after lease acquisition**

`src/worker/runtime.ts` exports these exact boundaries:

```ts
export interface WorkerPort {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
}
export interface WorkerStartOptions {
  dbPath: string;
  port: WorkerPort;
  identity: WorkerIdentity;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
}
export interface WorkerRuntime { prepareQuit(deadlineMs: number): Promise<void>; }
export async function startWorker(options: WorkerStartOptions): Promise<WorkerRuntime>;
```

Inside `startWorker`, perform this order exactly: `openDatabase` → `runMigrations` → `createWorkerLeaseStore` → `acquire`. If the lease is held, post a parsed `worker.rejected` envelope, close the database, and return an already-stopped runtime. If acquired, create repositories, EventStore, IdempotencyStore, Project/Room services, handlers, and router; only then post `worker.ready` with `protocolVersion: 1` and the exact generation. Start a heartbeat interval; if an exact-identity update returns false, stop accepting commands and close the database.

For every parent message: run `assertEnvelopeSize`, parse `WorkerRequestEnvelopeSchema`, route it, and post the parsed response. After a successful, non-replayed `message.post` response, also post a `room.event` envelope whose idempotency key is the event ID. `prepareQuit` must be idempotent: unsubscribe the port, clear the heartbeat, release only the exact identity, close once, and resolve before its deadline. It never removes another generation's lease.

- [ ] **Step 6: Add the utility-process entry and worker build input**

`src/worker/index.ts` reads and validates `BRANCHESTRA_DB_PATH`, `BRANCHESTRA_OWNER_INSTANCE_ID`, `BRANCHESTRA_WORKER_GENERATION`, and `BRANCHESTRA_WORKER_START_IDENTITY`; adapts `process.parentPort` to `WorkerPort`; and calls `startWorker` with PID, `leaseTtlMs: 5_000`, and `heartbeatIntervalMs: 1_000`. Missing parent port or environment values throw before opening SQLite.

Update the Main build in `electron.vite.config.ts` so Rollup has two explicit inputs and stable output names:

```ts
main: {
  plugins: [externalizeDepsPlugin()],
  build: { rollupOptions: { input: { index: resolve("src/main/index.ts"), worker: resolve("src/worker/index.ts") } } }
}
```

The built worker entry is therefore `out/main/worker.js` next to `out/main/index.js`.

- [ ] **Step 7: Verify exclusive ownership, handshake, and build output**

Run: `pnpm exec vitest run tests/integration/worker-runtime.test.ts`

Expected: PASS with 1 test; only generations 1 and 3 announce ready, while generation 2 announces `LEASE_HELD`.

Run: `pnpm build`

Expected: electron-vite emits both `out/main/index.js` and `out/main/worker.js`.

- [ ] **Step 8: Commit**

```bash
git add electron.vite.config.ts src/shared/contracts/protocol.ts src/worker/storage/worker-lease-store.ts src/worker/runtime.ts src/worker/index.ts tests/integration/worker-runtime.test.ts
git commit -m "feat: enforce exclusive worker generation lease"
```

### Task 9: Main Worker Supervisor, Single Instance, and Re-Entrant Quit

**Files:**
- Create: `src/main/worker/utility-process-adapter.ts`
- Create: `src/main/worker/supervisor.ts`
- Create: `src/main/lifecycle.ts`
- Create: `src/main/bootstrap.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/worker-supervisor.test.ts`
- Test: `tests/unit/lifecycle.test.ts`

**Interfaces:**
- Consumes: built `worker.js`, worker ready/rejected/response/event envelopes, and secure window creation.
- Produces: `UtilityProcessAdapter`; `WorkerSupervisor.start/request/subscribe/stop/getGeneration`; bounded restart schedule `[100, 250, 500, 1000, 2000]`; `installApplicationLifecycle`.

- [ ] **Step 1: Write a failing supervisor test for handshake correlation and bounded restart**

Use a fake `UtilityProcessAdapter` whose child records environment variables, messages, exit listeners, and `kill` calls. Inject deterministic generations and a scheduler that records delays. The test must assert: `start()` resolves only after a `worker.ready` event with protocol 1 and the spawned UUID; an unexpected exit emits `worker.disconnected`; restart delays are exactly `100`, `250`, `500`, `1000`, then capped at `2000`; pending requests reject on exit; and `stop(deadline)` sends one `worker.prepareQuit` before calling `kill` only if no prepared response arrives.

```ts
// tests/unit/worker-supervisor.test.ts (first assertion slice)
const supervisor = createWorkerSupervisor({
  utilityProcess: fakeAdapter,
  workerEntry: "/app/out/main/worker.js",
  dbPath: "/data/branchestra.sqlite3",
  ownerInstanceId: "60000000-0000-4000-8000-000000000001",
  nextGeneration: () => generations.shift()!,
  restartBackoffMs: [100, 250, 500, 1000, 2000],
  schedule: fakeSchedule
});
const starting = supervisor.start();
expect(fakeAdapter.children).toHaveLength(1);
fakeAdapter.children[0]!.emitMessage(readyEnvelope(generationsUsed[0]!));
await expect(starting).resolves.toEqual({ workerGeneration: generationsUsed[0] });
```

- [ ] **Step 2: Run the supervisor test to verify it fails**

Run: `pnpm exec vitest run tests/unit/worker-supervisor.test.ts`

Expected: FAIL because `createWorkerSupervisor` does not exist.

- [ ] **Step 3: Define and implement the utility-process adapter and supervisor state machine**

```ts
// src/main/worker/supervisor.ts (exported seam)
import type { WorkerEventEnvelope, WorkerRequestEnvelope, WorkerResponseEnvelope } from "../../shared/contracts/protocol";

export interface WorkerReady { workerGeneration: string; }
export interface WorkerSupervisor {
  start(): Promise<WorkerReady>;
  request(request: WorkerRequestEnvelope): Promise<WorkerResponseEnvelope>;
  subscribe(listener: (event: WorkerEventEnvelope) => void): () => void;
  stop(deadlineMs: number): Promise<void>;
  getGeneration(): string | null;
}
export function createWorkerSupervisor(dependencies: WorkerSupervisorDependencies): WorkerSupervisor;
```

`src/main/worker/utility-process-adapter.ts` wraps only `utilityProcess.fork`, `postMessage`, `message`, `exit`, and `kill`. Spawn with an environment allowlist containing `LANG`, `LC_ALL`, `TMPDIR`, and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, plus the four `BRANCHESTRA_*` values; do not spread all of `process.env`.

For each spawn, generate a new UUID generation and start identity, set state to `starting`, and wait at most 5 seconds for a schema-valid `worker.ready` with the same generation and protocol version. Correlate responses by `requestId`. Forward schema-valid worker events to subscribers. On unexpected exit: reject pending requests, emit `worker.disconnected`, and schedule a single replacement with the next bounded delay. Reset the backoff index only after a ready worker remains alive for 5 seconds. A `worker.rejected/LEASE_HELD` follows the same bounded restart path and never becomes ready.

`stop(deadlineMs)` is idempotent: mark stopping, cancel scheduled restart, send one `worker.prepareQuit` request using the current generation, wait only until the absolute deadline, then call `kill()` if no success response arrived. Once stopping, exit events do not spawn replacements.

- [ ] **Step 4: Verify the supervisor state machine**

Run: `pnpm exec vitest run tests/unit/worker-supervisor.test.ts`

Expected: PASS; handshake generation matches, pending requests reject on exit, backoff is bounded, and graceful stop avoids `kill`.

- [ ] **Step 5: Write a failing lifecycle test for the single-instance gate and repeated `before-quit` events**

```ts
// tests/unit/lifecycle.test.ts
import { describe, expect, it, vi } from "vitest";
import { installApplicationLifecycle } from "../../src/main/lifecycle";

describe("application lifecycle", () => {
  it("does not start a worker or window without the single-instance lock", () => {
    const fixture = lifecycleFixture({ lock: false });
    installApplicationLifecycle(fixture.dependencies);
    expect(fixture.app.quit).toHaveBeenCalledOnce();
    expect(fixture.supervisor.start).not.toHaveBeenCalled();
    expect(fixture.createWindow).not.toHaveBeenCalled();
  });

  it("runs one worker quit handshake when before-quit is emitted twice", async () => {
    const fixture = lifecycleFixture({ lock: true });
    installApplicationLifecycle(fixture.dependencies);
    await fixture.emitReady();
    const first = fixture.emitBeforeQuit();
    const second = fixture.emitBeforeQuit();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.supervisor.stop).toHaveBeenCalledOnce();
    await fixture.finishStop();
    expect(fixture.app.quit).toHaveBeenCalledOnce();
  });
});
```

The test file implements `lifecycleFixture` as a local fake event emitter; it is not a production helper.

- [ ] **Step 6: Run the lifecycle test to verify it fails**

Run: `pnpm exec vitest run tests/unit/lifecycle.test.ts`

Expected: FAIL because `installApplicationLifecycle` does not exist.

- [ ] **Step 7: Implement the single-instance and quit lifecycle**

```ts
// src/main/lifecycle.ts (core control flow)
export function installApplicationLifecycle(dependencies: LifecycleDependencies): void {
  if (!dependencies.app.requestSingleInstanceLock()) {
    dependencies.app.quit();
    return;
  }
  let allowQuit = false;
  let quitPromise: Promise<void> | null = null;
  dependencies.app.on("second-instance", () => dependencies.focusWindow());
  dependencies.app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (quitPromise) return;
    const deadlineMs = Date.now() + dependencies.quitTimeoutMs;
    quitPromise = dependencies.supervisor.stop(deadlineMs).finally(() => {
      allowQuit = true;
      dependencies.app.quit();
    });
  });
  void dependencies.app.whenReady().then(async () => {
    await dependencies.supervisor.start();
    await dependencies.createWindow();
  });
}
```

`src/main/bootstrap.ts` creates the worker entry path next to Main output, database path `join(app.getPath("userData"), "branchestra.sqlite3")`, UUID owner instance, supervisor, and secure BrowserWindow factory, then installs this lifecycle. `src/main/index.ts` becomes only `import { bootstrapMain } from "./bootstrap"; bootstrapMain();`.

- [ ] **Step 8: Verify lifecycle, supervisor, type checking, and build**

Run: `pnpm exec vitest run tests/unit/worker-supervisor.test.ts tests/unit/lifecycle.test.ts`

Expected: PASS; the no-lock case starts nothing and the repeated quit case calls `stop` exactly once.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm build`

Expected: Main and Worker bundle successfully and the worker entry path remains `out/main/worker.js`.

- [ ] **Step 9: Commit**

```bash
git add src/main/worker/utility-process-adapter.ts src/main/worker/supervisor.ts src/main/lifecycle.ts src/main/bootstrap.ts src/main/index.ts tests/unit/worker-supervisor.test.ts tests/unit/lifecycle.test.ts
git commit -m "feat: supervise a single utility worker"
```

### Task 10: Injectable Project Dialog, Validated Renderer Gateway, and Two-Method Preload

**Files:**
- Create: `src/main/dialog/project-dialog.ts`
- Create: `src/main/ipc/renderer-gateway.ts`
- Create: `src/preload/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/bootstrap.ts`
- Test: `tests/unit/renderer-gateway.test.ts`
- Test: `tests/unit/preload-api.test.ts`

**Interfaces:**
- Consumes: `BranchestraApi`, strict Renderer/Worker schemas, current supervisor generation, and Worker request/response transport.
- Produces: `ProjectDialogAdapter.pickExistingProject(parentWindow): Promise<string | null>`; `registerRendererGateway`; `PreloadTransport`; `createPreloadApi(transport): BranchestraApi`; channels `branchestra:request` and `branchestra:event` only.

- [ ] **Step 1: Write a failing gateway test proving the path originates in Main and sender checks precede dispatch**

```ts
// tests/unit/renderer-gateway.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerRendererGateway } from "../../src/main/ipc/renderer-gateway";

describe("renderer gateway", () => {
  it("translates an empty project picker request using the injected Main dialog", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);
    const response = await fixture.invoke(42, {
      v: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      idempotencyKey: "pick-1",
      workerGeneration: fixture.generation,
      type: "project.pickExisting",
      payload: {}
    });
    expect(fixture.dialog.pickExistingProject).toHaveBeenCalledOnce();
    expect(fixture.supervisor.request).toHaveBeenCalledWith(expect.objectContaining({ type: "project.addExisting", payload: { selectedPath: "/selected/by/main" } }));
    expect(response).toMatchObject({ payload: { ok: true, requestType: "project.pickExisting" } });
  });

  it("rejects an untrusted sender without showing a dialog", async () => {
    const fixture = gatewayFixture({ selectedPath: "/selected/by/main", senderId: 42 });
    registerRendererGateway(fixture.dependencies);
    await expect(fixture.invoke(99, validSnapshotRequest(fixture.generation))).rejects.toThrow("Untrusted renderer sender");
    expect(fixture.dialog.pickExistingProject).not.toHaveBeenCalled();
    expect(fixture.supervisor.request).not.toHaveBeenCalled();
  });
});
```

`gatewayFixture` is local test wiring for a fake `ipcMain.handle`, dialog, supervisor, and WebContents sender. Its fake Worker response uses the same request correlation and a schema-valid Project.

- [ ] **Step 2: Run the gateway test to verify it fails**

Run: `pnpm exec vitest run tests/unit/renderer-gateway.test.ts`

Expected: FAIL because `registerRendererGateway` does not exist.

- [ ] **Step 3: Implement the injectable native dialog without Git logic**

```ts
// src/main/dialog/project-dialog.ts
import { dialog, type BrowserWindow } from "electron";

export interface ProjectDialogAdapter {
  pickExistingProject(parentWindow: BrowserWindow): Promise<string | null>;
}

export function createElectronProjectDialog(): ProjectDialogAdapter {
  return {
    async pickExistingProject(parentWindow) {
      const result = await dialog.showOpenDialog(parentWindow, {
        title: "Add Existing Git Project",
        buttonLabel: "Add Project",
        properties: ["openDirectory", "dontAddToRecent"]
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  };
}
```

- [ ] **Step 4: Implement sender, size, schema, generation, and picker translation in Main**

`registerRendererGateway` receives `{ ipcMain, trustedWebContents, parentWindow, dialog, supervisor }` and returns a disposer. Register exactly one handler on `branchestra:request` and use this order:

1. Compare `event.sender.id` to `trustedWebContents.id`; reject before parsing or side effects if unequal.
2. Call `assertEnvelopeSize(raw)` and `RendererRequestEnvelopeSchema.parse(raw)`.
3. Read `supervisor.getGeneration()`; reject if no ready worker.
4. Accept the zero generation only for `state.getSnapshot`, then stamp the active generation. Require exact equality for every other request.
5. For `project.pickExisting`, await the dialog. On cancel return a schema-valid success with `{ cancelled: true }`; otherwise construct a Worker request of type `project.addExisting` with the dialog result.
6. Map `state.getSnapshot`, `room.replay`, `room.create`, and `message.post` to same-named Worker commands; there is no generic forwarding of arbitrary strings.
7. Await `supervisor.request`, rewrite only `payload.requestType` from `project.addExisting` to `project.pickExisting`, parse the final Worker response schema, and return it.
8. Subscribe to supervisor events and send parsed events on `branchestra:event`; the disposer removes the IPC handler and subscription.

The gateway never accepts `selectedPath`, `filePath`, executable names, argv, or shell text from Renderer.

- [ ] **Step 5: Verify the Main gateway**

Run: `pnpm exec vitest run tests/unit/renderer-gateway.test.ts`

Expected: PASS; the trusted empty picker request gains the injected Main path, while the untrusted sender produces no dialog or worker call.

- [ ] **Step 6: Write a failing pure preload API test**

```ts
// tests/unit/preload-api.test.ts
import { describe, expect, it } from "vitest";
import { createPreloadApi } from "../../src/preload/api";
import { ZERO_WORKER_GENERATION } from "../../src/shared/contracts/protocol";

describe("preload API", () => {
  it("exposes only request and subscribe and learns generation from responses", async () => {
    const transport = fakePreloadTransport();
    const api = createPreloadApi(transport);
    expect(Object.keys(api).sort()).toEqual(["request", "subscribe"]);
    const bootstrap = api.request({ type: "state.getSnapshot", payload: {}, idempotencyKey: "snapshot-1" });
    expect(transport.invocations[0]).toMatchObject({ workerGeneration: ZERO_WORKER_GENERATION, type: "state.getSnapshot" });
    transport.resolveNext(snapshotResponse("50000000-0000-4000-8000-000000000001"));
    await bootstrap;
    void api.request({ type: "project.pickExisting", payload: {}, idempotencyKey: "pick-1" });
    expect(transport.invocations[1]).toMatchObject({ workerGeneration: "50000000-0000-4000-8000-000000000001", type: "project.pickExisting", payload: {} });
  });
});
```

- [ ] **Step 7: Run the preload test to verify it fails**

Run: `pnpm exec vitest run tests/unit/preload-api.test.ts`

Expected: FAIL because `createPreloadApi` does not exist.

- [ ] **Step 8: Implement generation-aware envelope creation and the narrow context bridge**

```ts
// src/preload/api.ts
import { randomUUID } from "node:crypto";
import type { BranchestraApi } from "../shared/contracts/renderer-api";
import { RendererRequestEnvelopeSchema, WorkerEventEnvelopeSchema, WorkerResponseEnvelopeSchema, ZERO_WORKER_GENERATION } from "../shared/contracts/protocol";

export interface PreloadTransport {
  invoke(channel: "branchestra:request", value: unknown): Promise<unknown>;
  on(channel: "branchestra:event", listener: (value: unknown) => void): () => void;
}

export function createPreloadApi(transport: PreloadTransport): BranchestraApi {
  let generation = ZERO_WORKER_GENERATION;
  return Object.freeze({
    async request(command) {
      const envelope = RendererRequestEnvelopeSchema.parse({ v: 1, requestId: randomUUID(), idempotencyKey: command.idempotencyKey, workerGeneration: generation, type: command.type, payload: command.payload });
      const response = WorkerResponseEnvelopeSchema.parse(await transport.invoke("branchestra:request", envelope));
      generation = response.workerGeneration;
      return response;
    },
    subscribe(listener) {
      return transport.on("branchestra:event", (raw) => {
        const event = WorkerEventEnvelopeSchema.parse(raw);
        generation = event.workerGeneration;
        listener(event);
      });
    }
  });
}
```

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";
import { createPreloadApi } from "./api";

const api = createPreloadApi({
  invoke: (channel, value) => ipcRenderer.invoke(channel, value),
  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
contextBridge.exposeInMainWorld("branchestra", api);
```

- [ ] **Step 9: Wire one gateway per BrowserWindow and verify the complete boundary**

Update `src/main/bootstrap.ts` so the BrowserWindow factory creates `createElectronProjectDialog()`, registers the renderer gateway with that window's WebContents, and calls the returned disposer on `closed`. Main still does not open SQLite or execute Git.

Run: `pnpm exec vitest run tests/unit/renderer-gateway.test.ts tests/unit/preload-api.test.ts tests/unit/protocol.test.ts`

Expected: PASS; there are only two exposed methods, the first snapshot uses the zero UUID, subsequent commands use the active UUID, and Renderer has no path-bearing command.

Run: `pnpm typecheck`

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/main/dialog/project-dialog.ts src/main/ipc/renderer-gateway.ts src/preload/api.ts src/preload/index.ts src/main/bootstrap.ts tests/unit/renderer-gateway.test.ts tests/unit/preload-api.test.ts
git commit -m "feat: bridge validated renderer commands"
```

### Task 11: Snapshot and `room_seq` Replay Timeline Store

**Files:**
- Create: `src/renderer/state/timeline-store.ts`
- Test: `tests/unit/timeline-store.test.ts`

**Interfaces:**
- Consumes: `BranchestraApi`, `AppSnapshot`, paged replay, and live `room.event` envelopes.
- Produces: `TimelineState`; `TimelineStore.getState/subscribe/hydrate/selectRoom/addProject/createRoom/postMessage/dispose`; `createTimelineStore(api, nextId)`.

- [ ] **Step 1: Write a failing store test for snapshot hydration, paged replay, duplicates, and a sequence gap**

```ts
// tests/unit/timeline-store.test.ts
import { describe, expect, it } from "vitest";
import { createTimelineStore } from "../../src/renderer/state/timeline-store";

describe("timeline store", () => {
  it("hydrates from snapshot, replays by cursor, ignores duplicates, and fills a gap", async () => {
    const api = timelineApiFixture({
      snapshot: foundationSnapshot({ latestRoomSeq: 3 }),
      replayPages: [eventPage([messageEvent(1), messageEvent(2)], true), eventPage([messageEvent(3)], false)]
    });
    const store = createTimelineStore(api, sequentialIds());
    await store.hydrate();
    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.roomSeq)).toEqual([1, 2, 3]);
    api.emit(roomEventEnvelope(messageEvent(3)));
    expect(store.getState().eventsByRoom[ROOM_ID]).toHaveLength(3);
    api.queueReplay(eventPage([messageEvent(4)], false));
    api.emit(roomEventEnvelope(messageEvent(5)));
    await api.flush();
    expect(api.replayCursors.at(-1)).toBe(3);
    expect(store.getState().eventsByRoom[ROOM_ID]?.map((event) => event.roomSeq)).toEqual([1, 2, 3, 4, 5]);
    store.dispose();
  });
});
```

The local fixture returns schema-valid UUIDs, timestamps, Project, Room, snapshot, response envelopes, and events; it records every `room.replay.payload.roomSeq` cursor.

- [ ] **Step 2: Run the timeline-store test to verify it fails**

Run: `pnpm exec vitest run tests/unit/timeline-store.test.ts`

Expected: FAIL because `src/renderer/state/timeline-store.ts` does not exist.

- [ ] **Step 3: Define the exact state and external-store interface**

```ts
// src/renderer/state/timeline-store.ts (exports)
export interface TimelineState {
  connection: "bootstrapping" | "ready" | "reconnecting" | "error";
  snapshot: AppSnapshot;
  selectedProjectId: string | null;
  selectedRoomId: string | null;
  eventsByRoom: Readonly<Record<string, readonly RoomEvent[]>>;
  error: string | null;
}
export interface TimelineStore {
  getState(): TimelineState;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  selectRoom(roomId: string): Promise<void>;
  addProject(): Promise<void>;
  createRoom(projectId: string, title: string): Promise<void>;
  postMessage(roomId: string, body: string): Promise<void>;
  dispose(): void;
}
export function createTimelineStore(api: BranchestraApi, nextId: () => string = () => crypto.randomUUID()): TimelineStore;
```

- [ ] **Step 4: Implement snapshot-first hydration and ordered replay**

On construction, subscribe once to Worker events. `hydrate()` sets `bootstrapping` or `reconnecting`, requests `state.getSnapshot`, parses success data with `AppSnapshotSchema`, preserves a still-valid selection or selects the first Project/Room, and invokes `catchUp(roomId)` for the selected Room.

`catchUp` reads the last cached sequence, requests `room.replay` in pages of 200, parses `RoomEventPageSchema`, and requires each newly accepted event sequence to equal the previous sequence plus one. Continue while `hasMore` or while the local cursor is below `snapshot.roomCursors[roomId]`. Deduplicate first by event ID and then by `roomSeq`; never sort over a gap.

Use this live-event rule:

```ts
if (event.roomSeq <= currentRoomSeq) return;
if (event.roomSeq === currentRoomSeq + 1) appendAndNotify(event);
else void catchUp(event.roomId).then(() => appendIfNext(event));
```

On `worker.disconnected`, set `reconnecting`. On a `worker.ready` with a new generation, call `hydrate` so a restarted worker is never trusted as a continuation of in-memory state.

- [ ] **Step 5: Implement commands with stable idempotency keys**

`addProject()` sends only `{ type: "project.pickExisting", payload: {}, idempotencyKey: nextId() }`; it never accepts a path parameter. `createRoom` and `postMessage` trim values before sending and reject empty values locally. After successful Project creation, re-hydrate the snapshot. After successful Room creation, parse the returned `Room`, re-hydrate, then call `selectRoom(createdRoom.id)` so the newly created Room is active. After successful `message.post`, parse the returned `RoomEvent` and append it; the later identical live event is ignored by ID/sequence.

All error responses set `connection: "error"` and expose their safe `message`; they do not retry mutations with a new idempotency key.

- [ ] **Step 6: Verify replay correctness and store types**

Run: `pnpm exec vitest run tests/unit/timeline-store.test.ts`

Expected: PASS; initial cursors are `0 → 2`, duplicate sequence 3 is ignored, and a live sequence-5 gap requests replay after sequence 3 before appending 5.

Run: `pnpm typecheck`

Expected: exit 0 with immutable public state and no Node imports in Renderer.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/state/timeline-store.ts tests/unit/timeline-store.test.ts
git commit -m "feat: replay persistent room timelines"
```

### Task 12: Three-Column Project, Timeline, and Inspector UI

**Files:**
- Create: `src/renderer/components/ProjectRail.tsx`
- Create: `src/renderer/components/Timeline.tsx`
- Create: `src/renderer/components/Inspector.tsx`
- Create: `src/renderer/components/Composer.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/unit/renderer-shell.test.tsx`

**Interfaces:**
- Consumes: `TimelineStore` and local `message.posted` events only.
- Produces: semantic three-column layout and stable test selectors `project-rail`, `shared-timeline`, `room-inspector`, `room-title-input`, `create-room`, `message-input`, and `send-message`.

- [ ] **Step 1: Write a failing server-rendered shell test**

```tsx
// tests/unit/renderer-shell.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../../src/renderer/App";

describe("renderer shell", () => {
  it("renders Project/Room navigation, shared timeline, inspector, and composer", () => {
    const html = renderToStaticMarkup(<App store={preloadedTimelineStore()} />);
    expect(html).toContain("Projects");
    expect(html).toContain("Rooms");
    expect(html).toContain("Shared Timeline");
    expect(html).toContain("Inspector");
    expect(html).toContain("Persisted hello");
    expect(html).toContain("data-testid=\"message-input\"");
  });
});
```

The local `preloadedTimelineStore` returns one Project, one Room, one `message.posted` event, and no-op command methods through the exact `TimelineStore` interface.

- [ ] **Step 2: Run the shell test to verify it fails**

Run: `pnpm exec vitest run tests/unit/renderer-shell.test.tsx`

Expected: FAIL because `App` does not accept a `TimelineStore` and the four components do not exist.

- [ ] **Step 3: Implement focused components with no task/provider behavior**

Use these exact responsibilities and props:

```tsx
export function ProjectRail(props: { state: TimelineState; onAddProject(): void; onSelectRoom(roomId: string): void; onCreateRoom(projectId: string, title: string): void }): React.JSX.Element;
export function Timeline(props: { events: readonly RoomEvent[] }): React.JSX.Element;
export function Inspector(props: { project: Project | null; room: Room | null; connection: TimelineState["connection"] }): React.JSX.Element;
export function Composer(props: { disabled: boolean; onSend(body: string): Promise<void> }): React.JSX.Element;
```

`ProjectRail` groups Rooms beneath their Project, has an “Add Project” button, and has a controlled room-title form using `room-title-input` and `create-room`. `Timeline` renders escaped React text from `event.payload.body` and labels it “You”; do not use `dangerouslySetInnerHTML`. `Inspector` shows canonical repository root, Room title, connection state, and “Local messages”; it contains no task, worktree, approval, or Provider controls. `Composer` clears its controlled textarea only after `onSend` resolves.

- [ ] **Step 4: Compose the store with `useSyncExternalStore` and hydrate once**

```tsx
// src/renderer/App.tsx (composition shape)
import { useEffect, useSyncExternalStore } from "react";
import type { TimelineStore } from "./state/timeline-store";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { ProjectRail } from "./components/ProjectRail";
import { Timeline } from "./components/Timeline";

export function App({ store }: { store: TimelineStore }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => { void store.hydrate(); return () => store.dispose(); }, [store]);
  const project = state.snapshot.projects.find((item) => item.id === state.selectedProjectId) ?? null;
  const room = state.snapshot.rooms.find((item) => item.id === state.selectedRoomId) ?? null;
  const events = room ? (state.eventsByRoom[room.id] ?? []) : [];
  return <main className="app-shell">
    <ProjectRail state={state} onAddProject={() => void store.addProject()} onSelectRoom={(id) => void store.selectRoom(id)} onCreateRoom={(projectId, title) => void store.createRoom(projectId, title)} />
    <section className="timeline-column"><header><h1>Shared Timeline</h1></header><Timeline events={events} /><Composer disabled={!room || state.connection !== "ready"} onSend={(body) => room ? store.postMessage(room.id, body) : Promise.resolve()} /></section>
    <Inspector project={project} room={room} connection={state.connection} />
  </main>;
}
```

Update `src/renderer/main.tsx` to construct one `createTimelineStore(window.branchestra)` outside React render and pass it to `<App store={store} />`.

- [ ] **Step 5: Add a resilient three-column layout**

Set `.app-shell` to a full-height CSS grid with `grid-template-columns: minmax(220px, 0.8fr) minmax(420px, 2fr) minmax(240px, 0.9fr)`. Give each column its own border and scroll container; keep the Composer sticky at the bottom of the middle column. At widths below 980px, make the Inspector a second row spanning the center/right columns without hiding content. Provide visible focus styles and a disabled style; do not load remote fonts or images.

- [ ] **Step 6: Verify UI structure, type checking, and build**

Run: `pnpm exec vitest run tests/unit/renderer-shell.test.tsx tests/unit/timeline-store.test.ts`

Expected: PASS; the server output contains all three columns and the persisted message.

Run: `pnpm typecheck`

Expected: exit 0.

Run: `pnpm build`

Expected: Renderer bundles without Node polyfills and CSP remains in the output HTML.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ProjectRail.tsx src/renderer/components/Timeline.tsx src/renderer/components/Inspector.tsx src/renderer/components/Composer.tsx src/renderer/App.tsx src/renderer/main.tsx src/renderer/styles.css tests/unit/renderer-shell.test.tsx
git commit -m "feat: render three-column local timeline"
```

### Task 13: Electron Restart-Persistence and Security E2E

**Files:**
- Create: `e2e/helpers/launch-branchestra.ts`
- Create: `e2e/foundation.spec.ts`
- Modify: `src/main/dialog/project-dialog.ts`
- Modify: `src/main/bootstrap.ts`
- Modify: `src/renderer/components/ProjectRail.tsx`
- Modify: `src/renderer/components/Timeline.tsx`
- Test: `e2e/foundation.spec.ts`

**Interfaces:**
- Consumes: packaged Electron build, real temporary Git fixture, Main-only dialog injection, full snapshot/replay path, and stable UI selectors.
- Produces: `launchBranchestra({ userDataPath, selectedProjectPath })`; guarded `createFixedProjectDialog`; end-to-end proof of restart persistence and renderer isolation.

- [ ] **Step 1: Write the failing Electron E2E before adding the fixed Main dialog adapter**

```ts
// e2e/foundation.spec.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../tests/fixtures/git-repository";
import { launchBranchestra } from "./helpers/launch-branchestra";

test("adds a Git project, persists multiple rooms/messages, and restores them after restart", async () => {
  const repository = createGitRepository();
  const userDataPath = mkdtempSync(join(tmpdir(), "branchestra-e2e-data-"));
  try {
    let application = await launchBranchestra({ userDataPath, selectedProjectPath: repository.root });
    let window = await application.firstWindow();
    await window.getByRole("button", { name: "Add Project" }).click();
    await expect(window.getByTestId("project-rail")).toContainText("branchestra-git-");
    await window.getByTestId("room-title-input").fill("Architecture");
    await window.getByTestId("create-room").click();
    await window.getByTestId("message-input").fill("Persisted architecture note");
    await window.getByTestId("send-message").click();
    await window.getByTestId("room-title-input").fill("UX");
    await window.getByTestId("create-room").click();
    await window.getByTestId("message-input").fill("Persisted UX note");
    await window.getByTestId("send-message").click();
    await application.close();

    application = await launchBranchestra({ userDataPath, selectedProjectPath: repository.root });
    window = await application.firstWindow();
    await expect(window.getByTestId("project-rail")).toContainText("Architecture");
    await expect(window.getByTestId("project-rail")).toContainText("UX");
    await window.getByRole("button", { name: "Architecture" }).click();
    await expect(window.getByTestId("shared-timeline")).toContainText("Persisted architecture note");
    await window.getByRole("button", { name: "UX" }).click();
    await expect(window.getByTestId("shared-timeline")).toContainText("Persisted UX note");
    const boundary = await window.evaluate(() => ({
      requireType: typeof (window as unknown as { require?: unknown }).require,
      processType: typeof (window as unknown as { process?: unknown }).process,
      apiKeys: Object.keys(window.branchestra).sort(),
      webviews: document.querySelectorAll("webview").length
    }));
    expect(boundary).toEqual({ requireType: "undefined", processType: "undefined", apiKeys: ["request", "subscribe"], webviews: 0 });
    await expect(window.evaluate(() => window.branchestra.request({ type: "project.addExisting", payload: { selectedPath: "/tmp/injected" }, idempotencyKey: "renderer-path-attempt" } as never))).rejects.toThrow();
    await application.close();
  } finally {
    repository.cleanup();
    rmSync(userDataPath, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Create the Electron launch helper and run the E2E to verify it fails**

`e2e/helpers/launch-branchestra.ts` calls Playwright's `_electron.launch` with the workspace root as the app argument and sets `BRANCHESTRA_E2E=1`, `BRANCHESTRA_E2E_USER_DATA`, and `BRANCHESTRA_E2E_PROJECT_PATH`. Preserve only OS variables Electron needs (`PATH`, `TMPDIR`, `LANG`, and `LC_ALL`) rather than passing credential-bearing environment variables.

Run: `pnpm build`

Expected: production build succeeds.

Run: `pnpm exec playwright test e2e/foundation.spec.ts`

Expected: FAIL at “Add Project” because the production native dialog has no E2E adapter yet.

- [ ] **Step 3: Add a Main-only, explicitly guarded fixed dialog adapter**

Extend `src/main/dialog/project-dialog.ts` with:

```ts
export function createFixedProjectDialog(selectedPath: string): ProjectDialogAdapter {
  if (selectedPath.length === 0) throw new Error("E2E project path is empty");
  return { pickExistingProject: async () => selectedPath };
}
```

At the beginning of `bootstrapMain`, before `app.whenReady`, require both `BRANCHESTRA_E2E_USER_DATA` and `BRANCHESTRA_E2E_PROJECT_PATH` when `BRANCHESTRA_E2E === "1"`; call `app.setPath("userData", e2eUserData)` and inject `createFixedProjectDialog(e2eProjectPath)`. If the flag is absent, ignore both path variables and use `createElectronProjectDialog()`. Neither value is placed in a Renderer response, preload global, or Renderer command.

- [ ] **Step 4: Add only the selectors needed to observe the real UI**

Add `data-testid="project-rail"` to the left navigation root and `data-testid="shared-timeline"` to the Timeline root. Keep the Task 12 form selectors. Room buttons use their visible Room titles as accessible names, so the E2E does not need internal IDs.

- [ ] **Step 5: Run the restart E2E and full verification suite**

Run: `pnpm build`

Expected: Main, Worker, Preload, and Renderer build successfully.

Run: `pnpm exec playwright test e2e/foundation.spec.ts`

Expected: PASS; both Rooms and their isolated messages return after a full Electron close/relaunch using the same user-data database, `window.require` and `window.process` are absent, only `request`/`subscribe` are exposed, and the path-bearing Renderer command is rejected.

Run: `pnpm test:unit`

Expected: all unit contract, Git argv, router, supervisor, lifecycle, preload, store, and shell tests pass.

Run: `pnpm test:integration`

Expected: all SQLite, event/dedupe, real Git, domain, and worker-lease integration tests pass.

Run: `pnpm typecheck`

Expected: exit 0 with strict TypeScript.

- [ ] **Step 6: Commit**

```bash
git add e2e/helpers/launch-branchestra.ts e2e/foundation.spec.ts src/main/dialog/project-dialog.ts src/main/bootstrap.ts src/renderer/components/ProjectRail.tsx src/renderer/components/Timeline.tsx
git commit -m "test: verify Electron restart persistence"
```
