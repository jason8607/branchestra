# Branchestra Hardening and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the completed Branchestra desktop vertical slice against untrusted content and process failures, add privacy-preserving diagnostics and policy gates, then produce signed and notarized arm64 and x64 releases installable from an official Homebrew tap.

**Architecture:** This milestone tightens the existing Renderer -> Preload -> Main -> Worker trust boundaries without adding a second state owner. Security decisions remain structured worker events, release policy is machine-checked before packaging, and each macOS architecture is built and smoke-tested on matching GitHub-hosted hardware before release assets and the Homebrew Cask are published.

**Tech Stack:** Electron 43.1.1, electron-vite 5.0.0, electron-builder 26.15.3, `@electron/asar` 4.2.0, React 19.2.7, TypeScript 6.0.3, Zod 4.4.3, react-markdown 10.1.0, rehype-sanitize 6.0.0, Testing Library React 16.3.2/DOM 10.4.1, jsdom 29.1.1, Vitest 4.1.10, Playwright 1.61.1, Node.js 24.18.0, pnpm 11.15.1, GitHub Actions, Homebrew Cask

## Global Constraints

- This plan starts after the foundation, Git/task engine, and provider-adapter plans pass in full.
- Keep `contextIsolation: true`, `nodeIntegration: false`, Chromium renderer sandboxing enabled, and expose no Node, filesystem, database, Git, or shell primitive to the Renderer.
- Treat Provider text, repository Markdown, filenames, diffs, ANSI output, test logs, URLs, SVG, and HTML as untrusted input.
- Approval controls are rendered only from trusted structured events; text that resembles a control never becomes an actionable control.
- Keep SQLite and workflow ownership in the single utility worker; do not introduce a daemon or work that continues after the app exits.
- Package Electron 43.1.1 for macOS 12.0 or newer as separate `arm64` and `x64` DMG/ZIP artifacts; do not create a universal artifact.
- Keep Electron's `RunAsNode` fuse enabled because the verified detached Provider runner launches the signed app executable with `ELECTRON_RUN_AS_NODE=1`; packaged smoke tests must exercise that exact path.
- Require Developer ID Application signing, hardened runtime, notarization, stapling, Gatekeeper verification, and matching-architecture packaged smoke tests.
- Do not bundle or redistribute a `claude` or `codex` executable; users supply independently installed official CLI executables.
- Public `claudeSubscription` stays disabled until repository-tracked written Anthropic approval passes the release-policy gate.
- Do not add API-key, custom-base-URL, cloud-provider, silent-updater, telemetry, crash-upload, deploy, push, or publish fallbacks.
- Keep local logs secret-redacted and opt-in diagnostic export secret-redacted; never write authentication tokens to logs, SQLite, or the Renderer.
- Every external or destructive operation remains a separately validated approval; final merge approval remains bound to `(targetRef, baseOid, candidateOid, diffHash, testSetHash)` and the current worker generation.

---

## Locked File Map

| Path | Responsibility |
|---|---|
| `src/main/window-options.ts` | Keep the only BrowserWindow on fixed security preferences and the packaged CSP. |
| `src/main/security/navigation-policy.ts` | Deny navigation/new windows and mediate explicit HTTPS link opening. |
| `src/renderer/components/safe-markdown.tsx` | Render untrusted Markdown without raw HTML or executable links. |
| `src/renderer/components/plain-log.tsx` | Render logs/diffs/ANSI-looking bytes only as text. |
| `src/main/ipc/validated-sender.ts` | Verify frame origin, sender lifecycle, message schema, and size before routing. |
| `src/main/lifecycle.ts` | Retain the idempotent quit handshake and bounded worker/process cleanup under negative tests. |
| `src/worker/security/enforcement-profile.ts` | Versioned, hashable sandbox/environment profile and support decision. |
| `src/worker/security/enforcement-probe.ts` | Execute negative capability probes and fail closed on any escape. |
| `tests/fixtures/security/probe-child.mjs` | Deterministic escape attempts used by integration and test-Mac smoke jobs. |
| `src/worker/diagnostics/redactor.ts` | Deterministic secret removal from structured values and text. |
| `src/worker/diagnostics/rotating-log.ts` | Permission-restricted, size-bounded local log files. |
| `src/worker/diagnostics/export-bundle.ts` | Create user-requested gzip JSON diagnostics without source contents or secrets. |
| `config/provider-policy.json` | Checked-in public-release provider decisions and approval evidence metadata. |
| `scripts/verify-release-policy.mjs` | Block a release when policy evidence, dates, or public feature flags disagree. |
| `scripts/verify-package-contents.mjs` | Reject provider binaries, secrets, unexpected native executables, or unpacked source maps. |
| `electron-builder.config.mjs` | Deterministic per-architecture package, signing, and notarization configuration. |
| `build/entitlements.mac.plist` | Minimal hardened-runtime entitlements for the main app. |
| `build/entitlements.mac.inherit.plist` | Matching entitlements inherited by Electron helpers. |
| `scripts/render-homebrew-cask.mjs` | Render architecture-aware Cask URLs and SHA-256 values from release metadata. |
| `.github/workflows/ci.yml` | Typecheck, unit, integration, Electron E2E, and unsigned package smoke checks. |
| `.github/workflows/release.yml` | Policy-gated native arm64/x64 signing, notarization, release, and tap update. |
| `SECURITY.md` | Threat boundary, vulnerability reporting, and local-data disclosure. |
| `PRIVACY.md` | Exact local-versus-Provider data behavior and diagnostic-export behavior. |
| `CONTRIBUTING.md` | Reproducible development, tests, fixtures, and provider-policy rules. |

### Task 1: Render all repository and Provider content as inert data

**Files:**
- Create: `src/main/security/navigation-policy.ts`
- Modify: `src/main/window-options.ts`
- Create: `src/renderer/components/safe-markdown.tsx`
- Create: `src/renderer/components/plain-log.tsx`
- Modify: `src/main/bootstrap.ts`
- Modify: `src/main/ipc/renderer-gateway.ts`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/components/Timeline.tsx`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `package.json`
- Test: `tests/unit/main/navigation-policy.test.ts`
- Test: `tests/unit/renderer/safe-markdown.test.tsx`
- Test: `e2e/untrusted-content.spec.ts`

**Interfaces:**
- Consumes: the existing `window.branchestra.request(envelope)` preload bridge and structured `RoomEvent` timeline model.
- Produces: hardened existing `createWindowOptions(preloadPath): BrowserWindowConstructorOptions`, `installNavigationPolicy(window): void`, `SafeMarkdown({ text }: { text: string }): React.JSX.Element`, `PlainLog({ text }: { text: string }): React.JSX.Element`, and request type `{ type: "external.open"; payload: { url: string; userGestureNonce: string } }`.

- [ ] **Step 1: Add failing unit tests for URL and Markdown handling**

```ts
// tests/unit/main/navigation-policy.test.ts
import { describe, expect, it, vi } from "vitest";
import { openVerifiedExternal } from "../../../src/main/security/navigation-policy.js";

describe("openVerifiedExternal", () => {
  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<script>1</script>"]) (
    "rejects %s",
    async (url) => {
      const open = vi.fn();
      await expect(openVerifiedExternal(url, "gesture-1", async () => true, open)).rejects.toThrow(
        "Only explicit HTTPS links can be opened",
      );
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("requires a confirmed current user gesture", async () => {
    const open = vi.fn();
    await expect(openVerifiedExternal("https://example.com", "expired", async () => false, open)).rejects.toThrow(
      "External link was not confirmed",
    );
    expect(open).not.toHaveBeenCalled();
  });
});
```

```tsx
// @vitest-environment jsdom
// tests/unit/renderer/safe-markdown.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SafeMarkdown } from "../../../src/renderer/components/safe-markdown.js";

describe("SafeMarkdown", () => {
  it("does not create HTML, images, controls, or executable links from model text", () => {
    const { container } = render(
      <SafeMarkdown text={'javascript payload\n\n<button data-approval="merge">Merge</button> ![x](https://evil.test/x) [run](javascript:alert(1))'} />,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText("javascript payload")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the imports fail**

Run: `pnpm vitest run tests/unit/main/navigation-policy.test.ts tests/unit/renderer/safe-markdown.test.tsx`

Expected: FAIL because `navigation-policy.ts` and `safe-markdown.tsx` do not exist.

- [ ] **Step 3: Implement fixed window settings, navigation denial, and inert renderers**

```ts
// src/main/window-options.ts
import type { BrowserWindowConstructorOptions } from "electron";

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  };
}
```

```ts
// src/main/security/navigation-policy.ts
import type { BrowserWindow, HandlerDetails } from "electron";

type ConfirmExternal = (url: string, userGestureNonce: string) => Promise<boolean>;
type OpenExternal = (url: string) => Promise<void>;

export async function openVerifiedExternal(
  rawUrl: string,
  userGestureNonce: string,
  confirmExternal: ConfirmExternal,
  openExternal: OpenExternal,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Only explicit HTTPS links can be opened");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Only explicit HTTPS links can be opened");
  }
  if (!(await confirmExternal(url.href, userGestureNonce))) {
    throw new Error("External link was not confirmed");
  }
  await openExternal(url.href);
}

export function installNavigationPolicy(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((_details: HandlerDetails) => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
```

```tsx
// src/renderer/components/safe-markdown.tsx
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

export function SafeMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      rehypePlugins={[rehypeSanitize]}
      skipHtml
      disallowedElements={["img", "iframe", "object", "embed", "form", "input", "button", "svg"]}
      unwrapDisallowed
      components={{
        a: ({ children, href }) => {
          if (!href?.startsWith("https://")) return <span>{children}</span>;
          return <a href={href} rel="noreferrer">{children}</a>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
```

```tsx
// src/renderer/components/plain-log.tsx
export function PlainLog({ text }: { text: string }): React.JSX.Element {
  return <pre className="plain-log">{text.replaceAll("\u001b", "\\u001b")}</pre>;
}
```

Install only the new production Markdown dependencies before adding the CSP; the exact Testing Library, user-event, and jsdom development dependencies were already pinned and installed in Milestone 1:

Run: `pnpm add --save-exact react-markdown@10.1.0 rehype-sanitize@6.0.0`

Expected: exit 0; production Markdown packages are in `dependencies`, existing DOM test packages remain in `devDependencies`, and the lockfile contains the exact direct versions.

Set this exact policy in `src/renderer/index.html`:

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/>
```

- [ ] **Step 4: Route clicks through a fresh gesture nonce and trusted Main confirmation**

In `SafeMarkdown`, replace the HTTPS anchor returned above with this click handler after adding `external.open` to the typed `RendererCommand` union; the preload bridge remains exactly the existing `request` and `subscribe` methods:

```tsx
return (
  <a
    href={href}
    rel="noreferrer"
    onClick={(event) => {
      event.preventDefault();
      void window.branchestra.request({
        type: "external.open",
        payload: { url: href, userGestureNonce: crypto.randomUUID() },
        idempotencyKey: crypto.randomUUID(),
      });
    }}
  >
    {children}
  </a>
);
```

Main must show a native confirmation whose detail is the canonical HTTPS URL and call `shell.openExternal` only after `response === 0`; no worker or Renderer-supplied boolean can bypass that dialog.

```ts
// src/main/ipc/renderer-gateway.ts (Main-only external.open branch)
await openVerifiedExternal(
  request.payload.url,
  request.payload.userGestureNonce,
  async (canonicalUrl) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      buttons: ["Open link", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: "Open this link in your default browser?",
      detail: canonicalUrl,
    });
    return response === 0;
  },
  (canonicalUrl) => shell.openExternal(canonicalUrl),
);
```

- [ ] **Step 5: Add the malicious-content Electron journey**

```ts
// e2e/untrusted-content.spec.ts
import { expect, test } from "@playwright/test";
import { launchTestApp } from "./support/launch-test-app.js";

test("untrusted timeline content cannot navigate, open windows, or fabricate approval controls", async () => {
  const app = await launchTestApp({ fixture: "malicious-timeline" });
  const page = await app.firstWindow();
  const initialUrl = page.url();
  await expect(page.getByRole("button", { name: "Approve final merge" })).toHaveCount(0);
  await expect(page.locator("webview, iframe, object, embed, form")).toHaveCount(0);
  await page.getByText("javascript payload").click();
  expect(page.url()).toBe(initialUrl);
  expect(await app.windows()).toHaveLength(1);
  await app.close();
});
```

- [ ] **Step 6: Run security unit and Electron tests**

Run: `pnpm vitest run tests/unit/main/navigation-policy.test.ts tests/unit/renderer/safe-markdown.test.tsx && pnpm build && pnpm playwright test e2e/untrusted-content.spec.ts`

Expected: both Vitest files PASS; Playwright launches one window, observes no actionable fake approval, and PASSes.

- [ ] **Step 7: Commit the inert-content boundary**

```bash
git add package.json pnpm-lock.yaml src/main/security src/main/window-options.ts src/main/bootstrap.ts src/main/ipc/renderer-gateway.ts src/shared/contracts/protocol.ts src/renderer/index.html src/renderer/components src/renderer/components/Timeline.tsx tests/unit/main/navigation-policy.test.ts tests/unit/renderer/safe-markdown.test.tsx e2e/untrusted-content.spec.ts
git commit -m "security: render provider content as inert data"
```

### Task 2: Reject malformed IPC and make shutdown idempotent

**Files:**
- Create: `src/main/ipc/validated-sender.ts`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/main/ipc/renderer-gateway.ts`
- Modify: `src/main/worker/supervisor.ts`
- Modify: `src/main/bootstrap.ts`
- Modify: `src/worker/storage/worker-lease-store.ts`
- Test: `tests/unit/main/validated-sender.test.ts`
- Test: `tests/integration/worker-generation.test.ts`
- Test: `e2e/worker-restart-replay.spec.ts`

**Interfaces:**
- Consumes: existing `MAX_IPC_BYTES = 65_536`, `assertEnvelopeSize(value)`, `WorkerSupervisor.request(request): Promise<WorkerResponseEnvelope>`, worker `prepareQuit(deadlineEpochMs): Promise<{ safeToExit: true }>`, durable `idempotency_records`, durable worker lease, and snapshot/cursor replay from the foundation plan.
- Produces: `validateSender(event, expectedWebContentsId, allowedRendererUrl): void` and negative tests around the existing envelope, generation, dedupe, lifecycle, and supervisor seams.

- [ ] **Step 1: Write failing tests for oversize input, stale generation, and repeated quit**

```ts
// tests/unit/main/validated-sender.test.ts
import type { IpcMainInvokeEvent } from "electron";
import { expect, it } from "vitest";
import { validateSender } from "../../../src/main/ipc/validated-sender.js";
import { assertEnvelopeSize } from "../../../src/shared/contracts/protocol.js";

function fakeInvokeEvent(input: { senderId: number; parent: object | null; url: string }): IpcMainInvokeEvent {
  return {
    sender: { id: input.senderId },
    senderFrame: { parent: input.parent, url: input.url },
  } as unknown as IpcMainInvokeEvent;
}

it("rejects an encoded envelope larger than 64 KiB", () => {
  expect(() => assertEnvelopeSize({ payload: { text: "x".repeat(65_537) } })).toThrow("IPC envelope exceeds 65536 bytes");
});

it("rejects subframes and origins other than the URL loaded by Main", () => {
  expect(() => validateSender(
    fakeInvokeEvent({ senderId: 7, parent: {}, url: "https://evil.test" }),
    7,
    "file:///Applications/Branchestra.app/Contents/Resources/app.asar/out/renderer/index.html",
  )).toThrow("Untrusted IPC sender");
});
```

- [ ] **Step 2: Run the focused tests and verify missing exports**

Run: `pnpm vitest run tests/unit/main/validated-sender.test.ts`

Expected: the existing size assertion PASSes and the suite FAILs because `validateSender` is not implemented.

- [ ] **Step 3: Add strict frame/origin checks to the existing validated gateway**

```ts
// src/main/ipc/validated-sender.ts
import type { IpcMainInvokeEvent } from "electron";

export function validateSender(event: IpcMainInvokeEvent, expectedWebContentsId: number, allowedRendererUrl: string): void {
  const frame = event.senderFrame;
  let locationMatches = false;
  try {
    const actual = new URL(frame?.url ?? "invalid:");
    const allowed = new URL(allowedRendererUrl);
    locationMatches = allowed.protocol === "file:"
      ? actual.protocol === "file:" && actual.pathname === allowed.pathname
      : actual.origin === allowed.origin;
  } catch {
    locationMatches = false;
  }
  if (event.sender.id !== expectedWebContentsId || !frame || frame.parent !== null || !locationMatches) {
    throw new Error("Untrusted IPC sender");
  }
}
```

Parse each envelope with the existing discriminated Zod schema after `assertEnvelopeSize`, reject `workerGeneration !== supervisor.generation`, and forward the validated command to Worker without touching SQLite in Main. Worker remains the sole database owner: it atomically inserts the durable idempotency record, performs the mutation, stores the response, commits, and only then acknowledges Main. A duplicate key is resolved by that same Worker transaction boundary.

- [ ] **Step 4: Add generation and replay integration coverage**

```ts
// tests/integration/worker-generation.test.ts
it("rejects a stale mutation and returns a fresh snapshot cursor after worker restart", async () => {
  const harness = await createWorkerHarness();
  const before = await harness.handshake();
  await harness.restartWorker();
  await expect(harness.request({ ...makeCreateRoomRequest(), workerGeneration: before.generation })).rejects.toThrow("STALE_WORKER_GENERATION");
  const after = await harness.handshake();
  expect(after.generation).not.toBe(before.generation);
  const replay = await harness.snapshotAndReplay("room-1", 0);
  expect(replay.events.map((event) => event.roomSeq)).toEqual([...replay.events.map((event) => event.roomSeq)].sort((a, b) => a - b));
});
```

- [ ] **Step 5: Run IPC, lease, restart, and shutdown tests**

Run: `pnpm vitest run tests/unit/main/validated-sender.test.ts tests/unit/lifecycle.test.ts tests/unit/worker-supervisor.test.ts tests/integration/worker-generation.test.ts && pnpm build && pnpm playwright test e2e/worker-restart-replay.spec.ts`

Expected: stale and oversize requests fail closed; a duplicate mutation appears once; restart replay is monotonic; repeated quit produces one handshake; all tests PASS.

- [ ] **Step 6: Commit IPC and lifecycle hardening**

```bash
git add src/shared/contracts/protocol.ts src/main/ipc src/main/worker/supervisor.ts src/main/bootstrap.ts src/worker/storage/worker-lease-store.ts tests/unit/main/validated-sender.test.ts tests/integration/worker-generation.test.ts e2e/worker-restart-replay.spec.ts
git commit -m "security: harden IPC and worker shutdown"
```

### Task 3: Gate every Provider combination on a verified enforcement profile

**Files:**
- Create: `src/worker/security/enforcement-profile.ts`
- Create: `src/worker/security/enforcement-probe.ts`
- Create: `tests/fixtures/security/probe-child.mjs`
- Create: `tests/integration/enforcement-profile.test.ts`
- Create: `tests/security/provider-sandbox-matrix.test.ts`
- Modify: `src/worker/providers/provider-registry.ts`
- Modify: `src/worker/process/provider-process-supervisor.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ProviderCapabilities`, external CLI realpath/version/auth result, `ProviderRunnerSupervisor.start`, project `repoRoot`/`gitCommonDir`, and task approval writable roots/tool-network flag.
- Produces: `EnforcementProfile`, `hashEnforcementProfile(profile): string`, `runEnforcementProbe(profile, deps): Promise<ProbeReport>`, and registry status `{ supported: false; code: "ENFORCEMENT_PROBE_FAILED"; report }` on any failed probe.

- [ ] **Step 1: Write the failing fail-closed profile test**

```ts
// tests/integration/enforcement-profile.test.ts
import { expect, it } from "vitest";
import { decideProviderSupport } from "../../src/worker/security/enforcement-profile.js";

it("does not start a provider when one required negative probe is missing or failed", () => {
  const decision = decideProviderSupport({
    profileHash: "sha256:profile",
    toolNetwork: false,
    results: [
      { name: "worktree-write", outcome: "allowed" },
      { name: "parent-traversal", outcome: "denied" },
      { name: "symlink-outside-write", outcome: "denied" },
      { name: "git-common-dir-write", outcome: "allowed" },
      { name: "other-ref-write", outcome: "denied" },
      { name: "child-outside-write", outcome: "denied" },
      { name: "credential-env-read", outcome: "denied" },
      { name: "tool-network-connect", outcome: "denied" },
    ],
  });
  expect(decision).toEqual({ supported: false, code: "ENFORCEMENT_PROBE_FAILED", failed: ["git-common-dir-write"] });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run tests/integration/enforcement-profile.test.ts`

Expected: FAIL because `enforcement-profile.ts` does not exist.

- [ ] **Step 3: Define the versioned profile and required probe set**

```ts
// src/worker/security/enforcement-profile.ts
import { createHash } from "node:crypto";

export const REQUIRED_PROBES = [
  "worktree-write",
  "parent-traversal",
  "symlink-outside-write",
  "git-common-dir-write",
  "other-ref-write",
  "child-outside-write",
  "credential-env-read",
  "tool-network-connect",
] as const;

export type ProbeName = (typeof REQUIRED_PROBES)[number];
export type ProbeOutcome = "allowed" | "denied" | "not-run";

export interface EnforcementProfile {
  schemaVersion: 1;
  provider: "claude" | "codex";
  sdkVersion: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
  writableRoots: readonly string[];
  readableRoots: readonly string[];
  gitCommonDir: string;
  toolNetwork: boolean;
  environmentKeys: readonly string[];
}

export interface ProbeReport {
  profileHash: string;
  toolNetwork: boolean;
  results: ReadonlyArray<{ name: ProbeName; outcome: ProbeOutcome }>;
}

export function hashEnforcementProfile(profile: EnforcementProfile): string {
  const canonical = JSON.stringify(profile, Object.keys(profile).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function decideProviderSupport(report: ProbeReport):
  | { supported: true }
  | { supported: false; code: "ENFORCEMENT_PROBE_FAILED"; failed: ProbeName[] } {
  const byName = new Map(report.results.map((result) => [result.name, result.outcome]));
  const failed = REQUIRED_PROBES.filter((name) => {
    const expected = name === "worktree-write" || (name === "tool-network-connect" && report.toolNetwork)
      ? "allowed"
      : "denied";
    return byName.get(name) !== expected;
  });
  return failed.length === 0 ? { supported: true } : { supported: false, code: "ENFORCEMENT_PROBE_FAILED", failed };
}
```

- [ ] **Step 4: Implement deterministic escape attempts and verified runner identity**

```js
// tests/fixtures/security/probe-child.mjs
import fs from "node:fs";
import net from "node:net";

const [operation, target] = process.argv.slice(2);
if (operation === "write") {
  fs.writeFileSync(target, "branchestra-probe", { flag: "wx" });
} else if (operation === "env") {
  const leaked = Object.keys(process.env).filter((key) => /(?:API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|BEDROCK|VERTEX|FOUNDRY)/i.test(key));
  if (leaked.length > 0) process.exitCode = 42;
} else if (operation === "connect") {
  const [host, port] = target.split(":");
  const socket = net.connect(Number(port), host, () => process.exit(43));
  socket.on("error", () => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
} else {
  process.exitCode = 64;
}
```

`runEnforcementProbe` must construct canonical in-root, `..`, symlink, Git-common-dir, ref, child, environment, and local TCP targets itself; it must never accept those targets from Renderer IPC. Persist the resulting profile hash and report with the `(SDK, CLI, architecture)` support record. `ProviderRegistry.startRun` must compare the current profile hash with the passing report before launching.

- [ ] **Step 5: Add the full negative matrix**

```ts
// tests/security/provider-sandbox-matrix.test.ts
for (const provider of ["claude", "codex"] as const) {
  test(`${provider} profile denies every unapproved capability`, async () => {
    const harness = await createSandboxHarness(provider, { toolNetwork: false });
    const report = await harness.probe();
    expect(report.results).toEqual(expect.arrayContaining([
      { name: "worktree-write", outcome: "allowed" },
      { name: "parent-traversal", outcome: "denied" },
      { name: "symlink-outside-write", outcome: "denied" },
      { name: "git-common-dir-write", outcome: "denied" },
      { name: "other-ref-write", outcome: "denied" },
      { name: "child-outside-write", outcome: "denied" },
      { name: "credential-env-read", outcome: "denied" },
      { name: "tool-network-connect", outcome: "denied" },
    ]));
  });

  test(`${provider} profile permits the network probe only after explicit approval`, async () => {
    const report = await createSandboxHarness(provider, { toolNetwork: true }).probe();
    expect(report.results.find((result) => result.name === "tool-network-connect")).toEqual({
      name: "tool-network-connect",
      outcome: "allowed",
    });
    expect(decideProviderSupport(report)).toEqual({ supported: true });
  });
}
```

Fixtures run with mock runtimes in ordinary public CI. Before release, a maintainer runs the same probe protocol on a controlled Mac with the exact supported external CLI versions and dedicated test subscriptions, then attaches the sanitized, hashed report to the release evidence; credentials and raw auth output never enter CI artifacts or repository files. The release workflow validates that report against the checked-in profile hash and review date. A missing or mismatched real-Provider report marks that Provider unsupported for the release rather than converting the check to a warning.

Add the exact package script `"test:security": "vitest run tests/security --testTimeout=30000"`; it is separate from the inherited unit/integration aggregate so CI and release verification cannot accidentally omit the negative capability matrix.

- [ ] **Step 6: Run the enforcement tests**

Run: `pnpm vitest run tests/integration/enforcement-profile.test.ts tests/security/provider-sandbox-matrix.test.ts`

Expected: the approved worktree write succeeds; every unapproved probe is denied; a missing/changed profile report blocks launch; both files PASS.

- [ ] **Step 7: Commit the support gate**

```bash
git add src/worker/security src/worker/providers/provider-registry.ts src/worker/process/provider-process-supervisor.ts tests/fixtures/security tests/integration/enforcement-profile.test.ts tests/security/provider-sandbox-matrix.test.ts package.json
git commit -m "security: verify provider enforcement profiles"
```

### Task 4: Add secret-redacted logs and opt-in diagnostics

**Files:**
- Create: `src/worker/diagnostics/redactor.ts`
- Create: `src/worker/diagnostics/rotating-log.ts`
- Create: `src/worker/diagnostics/export-bundle.ts`
- Create: `src/renderer/features/settings/diagnostics-panel.tsx`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/main/dialogs/save-dialog.ts`
- Modify: `src/worker/index.ts`
- Test: `tests/unit/worker/redactor.test.ts`
- Test: `tests/integration/diagnostic-export.test.ts`
- Test: `e2e/diagnostic-export.spec.ts`

**Interfaces:**
- Consumes: worker repositories for non-secret health/status summaries and Main save-dialog adapter.
- Produces: `redactText(text): string`, `redactValue(value): unknown`, `RotatingLog.write(record): Promise<void>`, and `exportDiagnosticBundle(input, destination): Promise<{ sha256: string; bytes: number }>`.

- [ ] **Step 1: Write failing secret-redaction tests**

```ts
// tests/unit/worker/redactor.test.ts
import { expect, it } from "vitest";
import { redactText, redactValue } from "../../../src/worker/diagnostics/redactor.js";

it("redacts tokens, authorization headers, credentials, and sensitive environment fields", () => {
  expect(redactText("Authorization: Bearer sk-ant-secret\nToken ghp_123456789012345678901234567890123456")).toBe(
    "Authorization: [REDACTED]\nToken [REDACTED]",
  );
  expect(redactValue({ PATH: "/opt/homebrew/bin", ANTHROPIC_API_KEY: "secret", nested: { password: "secret" } })).toEqual({
    PATH: "/opt/homebrew/bin",
    ANTHROPIC_API_KEY: "[REDACTED]",
    nested: { password: "[REDACTED]" },
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `pnpm vitest run tests/unit/worker/redactor.test.ts`

Expected: FAIL because `redactor.ts` does not exist.

- [ ] **Step 3: Implement structural and textual redaction**

```ts
// src/worker/diagnostics/redactor.ts
const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|base[_-]?url|bedrock|vertex|foundry)/i;
const SECRET_TEXT = /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/gi;

export function redactText(text: string): string {
  return text.replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: [REDACTED]").replace(SECRET_TEXT, "[REDACTED]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child)]),
    );
  }
  return value;
}
```

- [ ] **Step 4: Implement bounded logs and a gzip JSON export**

```ts
// src/worker/diagnostics/export-bundle.ts
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { redactValue } from "./redactor.js";

export interface DiagnosticInput {
  appVersion: string;
  platform: { os: string; arch: string; electron: string; node: string };
  providerHealth: unknown;
  taskStateCounts: Record<string, number>;
  recentErrors: unknown[];
}

export async function exportDiagnosticBundle(
  input: DiagnosticInput,
  destination: string,
): Promise<{ sha256: string; bytes: number }> {
  const payload = Buffer.from(JSON.stringify(redactValue({ schemaVersion: 1, exportedAt: new Date().toISOString(), ...input }), null, 2));
  const compressed = gzipSync(payload, { level: 9 });
  await writeFile(destination, compressed, { mode: 0o600, flag: "wx" });
  return { sha256: createHash("sha256").update(compressed).digest("hex"), bytes: compressed.byteLength };
}
```

`RotatingLog` must open files with mode `0o600`, redact before serialization, rotate at exactly 5 MiB, retain five files, and perform rename/write through its single worker-owned queue. Diagnostic input excludes message bodies, source files, raw diffs, raw Provider payloads, environment values, and CLI auth output.

- [ ] **Step 5: Add export integration and UI tests**

```ts
// tests/integration/diagnostic-export.test.ts
it("exports only redacted metadata with owner-only permissions", async () => {
  const destination = path.join(tempDir, "branchestra-diagnostics.json.gz");
  await exportDiagnosticBundle(fixtureWithSecrets(), destination);
  const stat = await fs.stat(destination);
  expect(stat.mode & 0o777).toBe(0o600);
  const decoded = gunzipSync(await fs.readFile(destination)).toString("utf8");
  expect(decoded).not.toContain("sk-ant-secret");
  expect(decoded).not.toContain("PRIVATE SOURCE BODY");
  expect(decoded).toContain("[REDACTED]");
});
```

The Settings button first shows the exact field list, then obtains a destination from the Main save-dialog adapter, and only then sends the worker a trusted destination capability. Cancellation creates no file; an existing file causes `EEXIST` and requires a new explicit save choice.

- [ ] **Step 6: Run diagnostics tests**

Run: `pnpm vitest run tests/unit/worker/redactor.test.ts tests/integration/diagnostic-export.test.ts && pnpm build && pnpm playwright test e2e/diagnostic-export.spec.ts`

Expected: secrets and source bodies are absent, file mode is `0600`, cancellation writes nothing, and all tests PASS.

- [ ] **Step 7: Commit diagnostics**

```bash
git add src/worker/diagnostics src/worker/index.ts src/renderer/features/settings/diagnostics-panel.tsx src/shared/contracts/protocol.ts src/main/dialogs/save-dialog.ts tests/unit/worker/redactor.test.ts tests/integration/diagnostic-export.test.ts e2e/diagnostic-export.spec.ts
git commit -m "feat: add privacy-safe local diagnostics"
```

### Task 5: Make local-data removal explicit and worktree cleanup recoverable

**Files:**
- Create: `src/worker/cleanup/cleanup-service.ts`
- Create: `src/worker/cleanup/cleanup-repository.ts`
- Create: `src/renderer/features/settings/data-management-panel.tsx`
- Modify: `src/shared/contracts/protocol.ts`
- Modify: `src/worker/git/git-manager.ts`
- Modify: `src/worker/operations/operation-journal.ts`
- Modify: `src/worker/storage/migrations.ts`
- Test: `tests/unit/worker/cleanup-service.test.ts`
- Test: `tests/integration/data-removal.test.ts`
- Test: `e2e/data-management.spec.ts`

**Interfaces:**
- Consumes: `GitManager.inspectWorktree`, `JournaledOperationRunner.run`, repository-scoped locks, Room/Project repositories, and trusted structured approval events.
- Produces: `CleanupPreview`, `CleanupReceipt`, `CleanupService.archiveWorktree`, `CleanupService.removeRoom`, `CleanupService.removeProjectMetadata`, and a recovery directory below the worker-owned `userData/recovery/worktrees` root.

- [ ] **Step 1: Write failing tests for stale receipts, active projects, and dirty worktrees**

```ts
// tests/unit/worker/cleanup-service.test.ts
import { describe, expect, it } from "vitest";
import { validateCleanupReceipt } from "../../../src/worker/cleanup/cleanup-service.js";

describe("validateCleanupReceipt", () => {
  it("binds room deletion to the observed event count and sequence", () => {
    expect(() => validateCleanupReceipt(
      { kind: "room", roomId: "room-1", eventCount: 8, throughSeq: 9, activeTaskCount: 0, confirmation: "DELETE room-1" },
      { kind: "room", roomId: "room-1", eventCount: 9, throughSeq: 10, activeTaskCount: 0 },
    )).toThrow("CLEANUP_RECEIPT_STALE");
  });

  it("requires an extra dirty-worktree confirmation", () => {
    expect(() => validateCleanupReceipt(
      { kind: "worktree", worktreeId: "wt-1", headOid: "a".repeat(40), dirtyHash: "sha256:dirty", allowDirtyArchive: false },
      { kind: "worktree", worktreeId: "wt-1", headOid: "a".repeat(40), dirtyHash: "sha256:dirty" },
    )).toThrow("DIRTY_WORKTREE_REQUIRES_ARCHIVE_CONFIRMATION");
  });
});
```

- [ ] **Step 2: Run the cleanup unit test and verify the module is missing**

Run: `pnpm vitest run tests/unit/worker/cleanup-service.test.ts`

Expected: FAIL because `cleanup-service.ts` does not exist.

- [ ] **Step 3: Define hash-bound previews and receipts**

```ts
// src/worker/cleanup/cleanup-service.ts
import { hashCanonical } from "../approvals/canonical-json.js";

export type CleanupPreview =
  | { kind: "room"; roomId: string; eventCount: number; throughSeq: number; activeTaskCount: number }
  | { kind: "project"; projectId: string; roomCount: number; activeTaskCount: number }
  | { kind: "worktree"; worktreeId: string; headOid: string; dirtyHash: string | null };

export type CleanupReceipt =
  | (Extract<CleanupPreview, { kind: "room" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "project" }> & { confirmation: string })
  | (Extract<CleanupPreview, { kind: "worktree" }> & { allowDirtyArchive: boolean });

function receiptBinding(value: CleanupPreview | CleanupReceipt): CleanupPreview {
  switch (value.kind) {
    case "room":
      return { kind: value.kind, roomId: value.roomId, eventCount: value.eventCount, throughSeq: value.throughSeq, activeTaskCount: value.activeTaskCount };
    case "project":
      return { kind: value.kind, projectId: value.projectId, roomCount: value.roomCount, activeTaskCount: value.activeTaskCount };
    case "worktree":
      return { kind: value.kind, worktreeId: value.worktreeId, headOid: value.headOid, dirtyHash: value.dirtyHash };
  }
}

export function validateCleanupReceipt(receipt: CleanupReceipt, current: CleanupPreview): void {
  if (hashCanonical(receiptBinding(receipt)) !== hashCanonical(receiptBinding(current))) {
    throw new Error("CLEANUP_RECEIPT_STALE");
  }
  if (current.kind === "project" && current.activeTaskCount !== 0) throw new Error("PROJECT_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && current.activeTaskCount !== 0) throw new Error("ROOM_HAS_ACTIVE_TASKS");
  if (current.kind === "room" && receipt.kind === "room" && receipt.confirmation !== `DELETE ${current.roomId}`) {
    throw new Error("ROOM_DELETE_CONFIRMATION_MISMATCH");
  }
  if (current.kind === "worktree" && current.dirtyHash && receipt.kind === "worktree" && !receipt.allowDirtyArchive) {
    throw new Error("DIRTY_WORKTREE_REQUIRES_ARCHIVE_CONFIRMATION");
  }
}
```

- [ ] **Step 4: Archive a managed worktree before unregistering it**

```ts
// src/worker/cleanup/cleanup-service.ts (class methods)
async archiveWorktree(receipt: Extract<CleanupReceipt, { kind: "worktree" }>): Promise<{ recoveryPath: string }> {
  return this.repositoryLock.withLock(this.project.gitCommonDir, async () => {
    const current = await this.gitManager.previewWorktreeCleanup(receipt.worktreeId);
    validateCleanupReceipt(receipt, current);
    const recoveryPath = path.join(this.recoveryRoot, receipt.worktreeId, this.ids.next());
    const timestamp = this.clock.now();
    return this.operationRunner.run({
      intent: {
        id: this.ids.next(),
        projectId: this.project.id,
        taskId: current.taskId,
        repositoryCommonDirRealpath: this.project.gitCommonDir,
        operationType: "archive-worktree",
        status: "intent",
        observation: null,
        workerGeneration: this.workerGeneration,
        createdAt: timestamp,
        updatedAt: timestamp,
        idempotencyKey: `archive-worktree:${receipt.worktreeId}:${current.headOid}:${current.dirtyHash ?? "clean"}`,
        expected: { source: current.path, recoveryPath, headOid: current.headOid, dirtyHash: current.dirtyHash },
      },
      execute: async () => {
        await fs.mkdir(path.dirname(recoveryPath), { recursive: true, mode: 0o700 });
        await fs.rename(current.path, recoveryPath);
        await this.gitManager.unregisterMissingWorktree(receipt.worktreeId, current.path);
      },
      observe: async () => {
        const actual = {
          sourceMissing: !(await exists(current.path)),
          recoveryPathExists: await exists(recoveryPath),
          stillRegistered: await this.gitManager.isWorktreeRegistered(current.path),
        };
        return actual.sourceMissing && actual.recoveryPathExists && !actual.stillRegistered
          ? { outcome: "applied" as const, actual, result: { recoveryPath } }
          : { outcome: "uncertain" as const, actual };
      },
    });
  });
}
```

The recovery directory must be inside canonical worker-owned `userData`, never a Renderer-supplied path. Keep the task branch and immutable checkpoint/candidate refs. UI copy states the exact recovery path and that a later purge is destructive; cancellation, task failure, or app quit never calls this method automatically.

- [ ] **Step 5: Delete only selected local metadata inside one SQLite transaction**

```ts
// src/worker/cleanup/cleanup-repository.ts
import type { Clock } from "../../shared/contracts/domain.js";
import type { Database } from "../storage/database.js";
import { validateCleanupReceipt, type CleanupPreview, type CleanupReceipt } from "./cleanup-service.js";

export class CleanupRepository {
  constructor(private readonly database: Database, private readonly clock: Clock) {}

  removeRoom(receipt: Extract<CleanupReceipt, { kind: "room" }>, current: Extract<CleanupPreview, { kind: "room" }>): void {
    validateCleanupReceipt(receipt, current);
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM rooms WHERE id = ?").run(receipt.roomId);
      const audit = this.database.prepare("INSERT INTO local_deletion_audit(kind, deleted_id, deleted_at) VALUES (?, ?, ?)");
      audit.run("room", receipt.roomId, this.clock.now());
    });
  }

  removeProjectMetadata(receipt: Extract<CleanupReceipt, { kind: "project" }>, current: Extract<CleanupPreview, { kind: "project" }>): void {
    validateCleanupReceipt(receipt, current);
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM projects WHERE id = ?").run(receipt.projectId);
      this.database.prepare("INSERT INTO local_deletion_audit(kind, deleted_id, deleted_at) VALUES (?, ?, ?)")
        .run("project", receipt.projectId, this.clock.now());
    });
  }
}
```

Foreign keys cascade only Branchestra-owned room/project records. These methods never remove the user's repository, branch, Git objects, external Provider sessions, or archived worktree directory. The deletion audit contains IDs/timestamps only, not deleted content. UI states that room/project metadata deletion is irreversible except for an external filesystem/Time Machine backup.

- [ ] **Step 6: Add transaction, archive, and UI journeys**

```ts
// tests/integration/data-removal.test.ts
it("archives dirty worktree bytes but removes only selected local room metadata", async () => {
  const harness = await createCleanupHarness();
  const archived = await harness.archiveDirtyWorktree({ allowDirtyArchive: true });
  expect(await fs.readFile(path.join(archived.recoveryPath, "untracked.txt"), "utf8")).toBe("keep me");
  expect(await harness.gitRefExists("refs/branchestra/checkpoints/checkpoint-1")).toBe(true);
  await harness.removeRoom("room-1");
  expect(await harness.roomExists("room-1")).toBe(false);
  expect(await harness.roomExists("room-2")).toBe(true);
  expect(await harness.repositoryExists()).toBe(true);
});
```

```ts
// e2e/data-management.spec.ts
test("shows consequences and refuses a stale cleanup preview", async ({ page }) => {
  await page.getByRole("button", { name: "Data management" }).click();
  await page.getByRole("button", { name: "Remove room metadata" }).click();
  await expect(page.getByText("This does not delete your Git repository")).toBeVisible();
  await page.getByLabel("Type to confirm").fill("DELETE room-1");
  await page.getByRole("button", { name: "Confirm local deletion" }).click();
  await expect(page.getByText("Room metadata removed; filesystem backups are the only recovery source")).toBeVisible();
});
```

- [ ] **Step 7: Run cleanup tests**

Run: `pnpm vitest run tests/unit/worker/cleanup-service.test.ts tests/integration/data-removal.test.ts && pnpm build && pnpm playwright test e2e/data-management.spec.ts`

Expected: stale/active/unconfirmed operations fail closed; dirty files remain in the recovery directory; selected metadata is gone; the Git repository and other room remain; all tests PASS.

- [ ] **Step 8: Commit explicit data lifecycle controls**

```bash
git add src/worker/cleanup src/worker/git/git-manager.ts src/worker/operations/operation-journal.ts src/worker/storage/migrations.ts src/renderer/features/settings/data-management-panel.tsx src/shared/contracts/protocol.ts tests/unit/worker/cleanup-service.test.ts tests/integration/data-removal.test.ts e2e/data-management.spec.ts
git commit -m "feat: add explicit recoverable cleanup controls"
```

### Task 6: Enforce Provider policy and package-content gates

**Files:**
- Create: `config/provider-policy.json`
- Create: `config/provider-evidence/openai-codex-subscription.md`
- Create from controlled runs: `config/provider-evidence/codex-0.144.6-arm64.json`
- Create from controlled runs: `config/provider-evidence/codex-0.144.6-x64.json`
- Create: `src/shared/contracts/provider-policy.ts`
- Create: `scripts/verify-release-policy.mjs`
- Create: `scripts/verify-package-contents.mjs`
- Create: `tests/unit/scripts/verify-release-policy.test.ts`
- Create: `tests/integration/package-contents.test.ts`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `src/shared/config/provider-release-policy.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: compiled public feature flags, Milestone 3 `config/codex-config-lock-manifest.json` plus its reviewed lock resource, controlled-run config-isolation reports, and the packaged `.app` path.
- Produces: strict `ProviderPolicySchema`, `pnpm verify:release-policy`, `pnpm verify:package -- <absolute-app-path>`, and a checked-in policy document with schema version 1.

- [ ] **Step 1: Write a failing policy-gate test**

```ts
// tests/unit/scripts/verify-release-policy.test.ts
import { expect, it } from "vitest";
import { verifyPolicy } from "../../../scripts/verify-release-policy.mjs";

it("blocks public Claude subscription support without approved written evidence", () => {
  expect(() => verifyPolicy({
    schemaVersion: 1,
    publicFeatures: { claudeSubscription: true, codexSubscription: false },
    providers: {
      claude: { status: "blocked", reviewedAt: "2026-07-21", sourceUrl: "https://code.claude.com/docs/en/legal-and-compliance", policyEvidence: null, enforcementReports: [] },
      codex: { status: "pending_evidence", reviewedAt: "2026-07-21", sourceUrl: "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan", policyEvidence: null, enforcementReports: [] },
    },
  }, new Date("2026-07-21T00:00:00Z"))).toThrow("claudeSubscription cannot be enabled");
});
```

- [ ] **Step 2: Run the policy test and verify it fails**

Run: `pnpm vitest run tests/unit/scripts/verify-release-policy.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Check in the blocked Claude decision and implement the gate**

```json
{
  "schemaVersion": 1,
  "publicFeatures": {
    "claudeSubscription": false,
    "codexSubscription": true
  },
  "providers": {
    "claude": {
      "status": "blocked",
      "sdkVersion": "0.3.216",
      "cliVersion": "2.1.206",
      "reviewedAt": "2026-07-21",
      "sourceUrl": "https://code.claude.com/docs/en/legal-and-compliance",
      "policyEvidence": null,
      "enforcementReports": []
    },
    "codex": {
      "status": "allowed",
      "sdkVersion": "0.144.6",
      "cliVersion": "0.144.6",
      "reviewedAt": "2026-07-21",
      "sourceUrl": "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan",
      "policyEvidence": {
        "kind": "official_documentation",
        "path": "config/provider-evidence/openai-codex-subscription.md",
        "scope": "External user-installed Codex CLI controlled programmatically through the Codex SDK using the user's separately authenticated ChatGPT plan"
      },
      "enforcementReports": [
        "config/provider-evidence/codex-0.144.6-arm64.json",
        "config/provider-evidence/codex-0.144.6-x64.json"
      ]
    }
  }
}
```

Define `ProviderPolicySchema` in `src/shared/contracts/provider-policy.ts` as a strict Zod schema: schema version `1`; both boolean feature flags; Provider status enum `blocked | pending_evidence | allowed | approved`; exact non-empty SDK/CLI versions; ISO review date; HTTPS official source; nullable strict evidence `{ kind: "official_documentation" | "written_approval"; path: string; scope: string }`; and an array of repository-relative `config/provider-evidence/*.json` enforcement-report paths. Reject unknown keys. The Renderer never receives this document or any evidence body.

Make the runtime feature object derive from that checked-in document so policy and compiled UI/registry state cannot drift:

```ts
// src/shared/config/provider-release-policy.ts
import rawProviderPolicy from "../../../config/provider-policy.json" with { type: "json" };
import { ProviderPolicySchema } from "../contracts/provider-policy.js";

const providerPolicy = ProviderPolicySchema.parse(rawProviderPolicy);

export const PUBLIC_PROVIDER_RELEASE_POLICY = Object.freeze({
  claudeSubscription: Object.freeze({
    enabled: providerPolicy.publicFeatures.claudeSubscription,
    writtenApproval: providerPolicy.providers.claude.policyEvidence?.kind === "written_approval"
      ? providerPolicy.providers.claude.policyEvidence.path
      : null,
  }),
  codexSubscription: Object.freeze({
    enabled: providerPolicy.publicFeatures.codexSubscription,
    policyStatus: providerPolicy.providers.codex.status,
  }),
});
```

```js
// scripts/verify-release-policy.mjs
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

function readTrackedEvidence(repoRoot, relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error("Provider evidence path must be repository-relative");
  const evidenceRoot = fs.realpathSync(path.join(repoRoot, "config/provider-evidence"));
  const requested = path.resolve(repoRoot, relativePath);
  const canonical = fs.realpathSync(requested);
  const relative = path.relative(evidenceRoot, canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Provider evidence escaped its directory");
  const stat = fs.lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Provider evidence must be a regular non-symlink file");
  execFileSync("/usr/bin/git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relativePath], { stdio: "ignore" });
  const dirty = execFileSync("/usr/bin/git", ["-C", repoRoot, "status", "--porcelain=v1", "--", relativePath], { encoding: "utf8" }).trim();
  if (dirty) throw new Error(`Provider evidence must be clean at the release commit: ${relativePath}`);
  return fs.readFileSync(requested, "utf8");
}

function readTrackedRepositoryBytes(repoRoot, relativePath) {
  const permitted = new Set([
    "config/codex-config-lock-manifest.json",
    "resources/codex/0.144.6/subscription.config.lock.toml",
  ]);
  if (!permitted.has(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error("Unexpected Codex config-lock path");
  }
  const requested = path.resolve(repoRoot, relativePath);
  const canonical = fs.realpathSync(requested);
  const relative = path.relative(fs.realpathSync(repoRoot), canonical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Codex config-lock path escaped the repository");
  }
  const stat = fs.lstatSync(requested);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Codex config-lock input must be a regular non-symlink file");
  execFileSync("/usr/bin/git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relativePath], { stdio: "ignore" });
  const dirty = execFileSync("/usr/bin/git", ["-C", repoRoot, "status", "--porcelain=v1", "--", relativePath], { encoding: "utf8" }).trim();
  if (dirty) throw new Error(`Codex config-lock input must be clean: ${relativePath}`);
  return fs.readFileSync(requested);
}

function readTrackedRepositoryFile(repoRoot, relativePath) {
  return readTrackedRepositoryBytes(repoRoot, relativePath).toString("utf8");
}

function verifyEnabledProvider(provider, record, now, repoRoot) {
  if (!record.policyEvidence || !record.policyEvidence.scope) throw new Error(`${provider} requires scoped policy evidence`);
  const policyBody = readTrackedEvidence(repoRoot, record.policyEvidence.path);
  if (!policyBody.includes(record.sourceUrl) || !policyBody.includes(record.policyEvidence.scope)) {
    throw new Error(`${provider} policy evidence does not bind its official source and scope`);
  }
  let expectedCodexLockHash = null;
  if (provider === "codex") {
    const manifestPath = "config/codex-config-lock-manifest.json";
    const manifest = JSON.parse(readTrackedRepositoryFile(repoRoot, manifestPath));
    if (manifest.schemaVersion !== 1 || manifest.cliVersion !== record.cliVersion ||
        !/^sha256:[a-f0-9]{64}$/.test(manifest.sha256)) {
      throw new Error("Codex config-lock manifest is invalid");
    }
    const lockBytes = readTrackedRepositoryBytes(repoRoot, manifest.repositoryPath);
    expectedCodexLockHash = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`;
    if (lockBytes.byteLength !== manifest.bytes || expectedCodexLockHash !== manifest.sha256) {
      throw new Error("Codex config lock does not match its reviewed manifest");
    }
  }
  const expectedArchitectures = new Set(["arm64", "x64"]);
  for (const reportPath of record.enforcementReports ?? []) {
    const report = JSON.parse(readTrackedEvidence(repoRoot, reportPath));
    const ageDays = Math.floor((now.getTime() - Date.parse(report.smokeAt)) / 86_400_000);
    if (!expectedArchitectures.has(report.architecture) || report.provider !== provider ||
        report.sdkVersion !== record.sdkVersion || report.cliVersion !== record.cliVersion ||
        report.decision !== "supported" || report.realProviderSmoke !== true ||
        (provider === "codex" && (report.configLockHash !== expectedCodexLockHash ||
          report.configLockCliVersion !== record.cliVersion || report.configIsolationCanary !== true)) ||
        !/^sha256:[a-f0-9]{64}$/.test(report.profileHash) || !Number.isFinite(ageDays) || ageDays < 0 || ageDays > 30) {
      throw new Error(`${provider} has invalid or stale enforcement evidence: ${reportPath}`);
    }
    expectedArchitectures.delete(report.architecture);
  }
  if (expectedArchitectures.size !== 0) throw new Error(`${provider} requires current arm64 and x64 enforcement reports`);
}

export function verifyPolicy(policy, now = new Date(), repoRoot = process.cwd()) {
  if (policy.schemaVersion !== 1) throw new Error("Unsupported provider policy schema");
  for (const provider of ["claude", "codex"]) {
    const record = policy.providers[provider];
    const ageDays = Math.floor((now.getTime() - Date.parse(`${record.reviewedAt}T00:00:00Z`)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 30) throw new Error(`${provider} policy review must be within 30 days of release`);
  }
  const claude = policy.providers.claude;
  if (policy.publicFeatures.claudeSubscription && (claude.status !== "approved" || claude.policyEvidence?.kind !== "written_approval")) {
    throw new Error("claudeSubscription cannot be enabled without written Anthropic approval evidence");
  }
  if (policy.publicFeatures.claudeSubscription) verifyEnabledProvider("claude", claude, now, repoRoot);
  if (policy.publicFeatures.codexSubscription && policy.providers.codex.status !== "allowed") {
    throw new Error("codexSubscription cannot be enabled without a current allowed policy decision");
  }
  if (policy.publicFeatures.codexSubscription) verifyEnabledProvider("codex", policy.providers.codex, now, repoRoot);
  return true;
}

if (process.argv[1] === path.resolve(import.meta.filename)) {
  verifyPolicy(JSON.parse(fs.readFileSync("config/provider-policy.json", "utf8")));
}
```

`readTrackedRepositoryFile`/`readTrackedRepositoryBytes` apply the same repository-relative, clean, Git-tracked, regular non-symlink checks as `readTrackedEvidence`, but accept only the exact manifest and manifest-declared `resources/codex/` lock paths. They do not accept caller-chosen paths. `openai-codex-subscription.md` records the official URL above, review date, exact scope string, and the conclusion that the official plan documentation permits programmatic Codex SDK control; a maintainer-authored status value without that tracked evidence is insufficient. The controlled harness introduced in Milestone 3 Task 14 is extended and run with this milestone's reviewed enforcement profile from Task 3 to generate the two final Codex JSON reports. Those reports contain Provider/SDK/CLI versions, architecture, profile hash, decision, `realProviderSmoke: true`, `configLockHash`, `configLockCliVersion`, `configIsolationCanary: true`, and `smokeAt`, but no prompts, source, auth output, or credentials. Do not fabricate these files: Task 6 remains blocked until both native reports exist.

The only permitted Claude transition is a reviewed commit changing `status` to `approved`, setting `policyEvidence.kind` to `written_approval`, recording the exact approved scope in a repository-relative tracked text evidence file, adding current arm64/x64 enforcement reports, and enabling the public feature in the same reviewed change. `readTrackedEvidence` proves every evidence path is a clean, Git-tracked, regular non-symlink beneath `config/provider-evidence` at the tagged commit. A URL, truthy string, self-declared status, missing architecture, or stale report never suffices.

- [ ] **Step 4: Reject bundled Provider binaries and sensitive files**

```js
// scripts/verify-package-contents.mjs
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { listPackage } from "@electron/asar";

const appPath = path.resolve(process.argv[2] ?? "");
if (!appPath.endsWith(".app") || !fs.statSync(appPath).isDirectory()) throw new Error("Expected an absolute packaged .app path");
const resourcesPath = path.join(appPath, "Contents", "Resources");
const codexLockManifest = JSON.parse(fs.readFileSync("config/codex-config-lock-manifest.json", "utf8"));
const packagedCodexLock = path.join(resourcesPath, codexLockManifest.packagedRelativePath);
const packagedCodexLockBytes = fs.readFileSync(packagedCodexLock);
const packagedCodexLockHash = `sha256:${createHash("sha256").update(packagedCodexLockBytes).digest("hex")}`;
if (packagedCodexLockBytes.byteLength !== codexLockManifest.bytes || packagedCodexLockHash !== codexLockManifest.sha256) {
  throw new Error("Packaged Codex config lock does not match the reviewed manifest");
}
const forbiddenExecutableName = /^(?:claude|codex)(?:\.exe)?$/i;
const forbiddenProviderPackage = /node_modules\/(?:@openai\/codex(?:\/|-(?!sdk(?:\/|$)))|@anthropic-ai\/claude-agent-sdk\/vendor\/)/i;
const forbiddenPath = /(?:\.env(?:\.|$)|auth\.json$|credentials|sessions\/|\.map$)/i;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else {
      const relative = path.relative(appPath, absolute).replaceAll(path.sep, "/");
      const stat = fs.statSync(absolute);
      const firstFour = fs.readFileSync(absolute).subarray(0, 4).toString("hex");
      const isMachO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]).has(firstFour);
      if (forbiddenExecutableName.test(entry.name) || forbiddenProviderPackage.test(relative) || forbiddenPath.test(relative) || isMachO) {
        throw new Error(`Forbidden packaged resource: ${relative}`);
      }
      if ((stat.mode & 0o111) !== 0 && /(?:claude|codex)/i.test(entry.name)) throw new Error(`Forbidden packaged executable: ${relative}`);
    }
  }
}

walk(resourcesPath);
const asarPath = path.join(resourcesPath, "app.asar");
if (fs.existsSync(asarPath)) {
  for (const entry of await listPackage(asarPath)) {
    const normalized = entry.replaceAll("\\", "/");
    if (forbiddenProviderPackage.test(normalized) || forbiddenPath.test(normalized)) {
      throw new Error(`Forbidden ASAR entry: ${normalized}`);
    }
  }
}
```

The package verifier remains the decisive defense so a future dependency layout change fails the build instead of silently shipping a binary. Task 7 creates `electron-builder.config.mjs` with matching SDK vendor/platform-executable and source-map exclusions; Task 6 does not edit a file that has not yet been created.

- [ ] **Step 5: Add package scripts and notices check**

```json
{
  "scripts": {
    "verify:release-policy": "node scripts/verify-release-policy.mjs",
    "verify:package": "node scripts/verify-package-contents.mjs",
    "licenses:check": "pnpm licenses list --prod --json"
  }
}
```

Install the archive inspector as an exact development dependency: `pnpm add --save-dev --save-exact @electron/asar@4.2.0`.

`THIRD_PARTY_NOTICES.md` must list every runtime dependency, exact version, license identifier, copyright source, and upstream URL from `pnpm licenses list --prod --json`. The test compares the sorted `(name, version, license)` triples against the notice headings and fails on additions or removals.

- [ ] **Step 6: Run policy and artifact-fixture tests**

Run: `pnpm vitest run tests/unit/scripts/verify-release-policy.test.ts tests/integration/package-contents.test.ts && pnpm verify:release-policy && pnpm licenses:check`

Expected: blocked Claude stays disabled; a missing/untracked/dirty/out-of-root policy file, a self-declared Codex status, a stale report, a version/profile/config-lock mismatch, a false/missing config-isolation canary, or a missing architecture fails; both current Codex controlled-run reports PASS; missing/corrupt packaged lock, fake Provider binaries, and secrets are rejected; notices match runtime dependencies.

- [ ] **Step 7: Commit policy and package gates**

```bash
git add config/provider-policy.json config/provider-evidence src/shared/contracts/provider-policy.ts scripts/verify-release-policy.mjs scripts/verify-package-contents.mjs tests/unit/scripts/verify-release-policy.test.ts tests/integration/package-contents.test.ts THIRD_PARTY_NOTICES.md src/shared/config/provider-release-policy.ts package.json pnpm-lock.yaml
git commit -m "build: gate provider policy and package contents"
```

### Task 7: Build, sign, notarize, and verify separate macOS architectures

**Files:**
- Create: `electron-builder.config.mjs`
- Create: `build/entitlements.mac.plist`
- Create: `build/entitlements.mac.inherit.plist`
- Create: `scripts/validate-release-config.mjs`
- Create: `scripts/verify-macos-artifact.sh`
- Create: `tests/unit/scripts/validate-release-config.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: production output from `pnpm build`, required release environment variables, and the Task 6 policy/artifact verifiers.
- Produces: `pnpm package:mac:arm64`, `pnpm package:mac:x64`, `pnpm verify:mac -- <app> <arm64|x64>`, architecture-specific DMG/ZIP names, and SHA-256 files.

- [ ] **Step 1: Write the failing typed release-config test**

```ts
// tests/unit/scripts/validate-release-config.test.ts
import { expect, it } from "vitest";
import { validateReleaseConfig } from "../../../scripts/validate-release-config.mjs";

it("requires a stable reverse-DNS bundle id and repository owner", () => {
  expect(() => validateReleaseConfig({ BRANCHESTRA_BUNDLE_ID: "", BRANCHESTRA_GITHUB_OWNER: "" })).toThrow(
    "BRANCHESTRA_BUNDLE_ID must be a controlled reverse-DNS identifier",
  );
  expect(validateReleaseConfig({
    BRANCHESTRA_BUNDLE_ID: "com.example.branchestra",
    BRANCHESTRA_GITHUB_OWNER: "example",
  })).toEqual({ bundleId: "com.example.branchestra", githubOwner: "example" });
});
```

- [ ] **Step 2: Run the config test and verify it fails**

Run: `pnpm vitest run tests/unit/scripts/validate-release-config.test.ts`

Expected: FAIL because `validate-release-config.mjs` does not exist.

- [ ] **Step 3: Implement release configuration validation**

```js
// scripts/validate-release-config.mjs
export function validateReleaseConfig(env) {
  const bundleId = env.BRANCHESTRA_BUNDLE_ID ?? "";
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/i.test(bundleId)) {
    throw new Error("BRANCHESTRA_BUNDLE_ID must be a controlled reverse-DNS identifier");
  }
  const githubOwner = env.BRANCHESTRA_GITHUB_OWNER ?? "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubOwner)) {
    throw new Error("BRANCHESTRA_GITHUB_OWNER must be a GitHub owner name");
  }
  return { bundleId, githubOwner };
}
```

Release CI supplies `BRANCHESTRA_GITHUB_OWNER=${{ github.repository_owner }}` and a protected repository variable for `BRANCHESTRA_BUNDLE_ID`. The environment-based value is an intentional release gate because the design forbids claiming a namespace the project does not control.

- [ ] **Step 4: Add deterministic electron-builder configuration**

```js
// electron-builder.config.mjs
import fs from "node:fs";
import { validateReleaseConfig } from "./scripts/validate-release-config.mjs";

const { bundleId } = validateReleaseConfig(process.env);
const providerPolicy = JSON.parse(fs.readFileSync("config/provider-policy.json", "utf8"));
const codexLockManifest = JSON.parse(fs.readFileSync("config/codex-config-lock-manifest.json", "utf8"));
const claudePackageRules = providerPolicy.publicFeatures.claudeSubscription
  ? ["!node_modules/@anthropic-ai/claude-agent-sdk/vendor/**"]
  : ["!node_modules/@anthropic-ai/claude-agent-sdk/**"];

export default {
  appId: bundleId,
  productName: "Branchestra",
  electronVersion: "43.1.1",
  asar: true,
  directories: { output: "release" },
  files: [
    "out/**",
    "package.json",
    "!**/*.map",
    ...claudePackageRules,
    "!node_modules/@openai/codex/**",
    "!node_modules/@openai/codex-*/**"
  ],
  extraResources: [{
    from: codexLockManifest.repositoryPath,
    to: codexLockManifest.packagedRelativePath,
  }],
  mac: {
    category: "public.app-category.developer-tools",
    minimumSystemVersion: "12.0",
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    forceCodeSigning: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    artifactName: "Branchestra-${version}-mac-${arch}.${ext}"
  },
  dmg: { sign: false },
  publish: null
};
```

Use this exact minimal entitlement dictionary in both plist files:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
```

Do not add `disable-library-validation`, inbound network, camera, microphone, location, or broad filesystem entitlements.

- [ ] **Step 5: Add architecture-specific commands and verifier**

```json
{
  "scripts": {
    "package:mac:arm64": "pnpm build && electron-builder --config electron-builder.config.mjs --mac --arm64",
    "package:mac:x64": "pnpm build && electron-builder --config electron-builder.config.mjs --mac --x64",
    "verify:mac": "bash scripts/verify-macos-artifact.sh"
  }
}
```

```bash
#!/usr/bin/env bash
# scripts/verify-macos-artifact.sh
set -euo pipefail
app_path="$1"
expected_arch="$2"
test -d "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
xcrun stapler validate "$app_path"
spctl --assess --verbose --type exec "$app_path"
actual_archs="$(lipo -archs "$app_path/Contents/MacOS/Branchestra")"
test "$actual_archs" = "$expected_arch"
node scripts/verify-package-contents.mjs "$app_path"
```

- [ ] **Step 6: Build an unsigned local fixture, then run signed verification on a signing host**

Run locally without release credentials: `BRANCHESTRA_BUNDLE_ID=com.example.branchestra BRANCHESTRA_GITHUB_OWNER=example CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --config electron-builder.config.mjs --mac dir --arm64 -c.mac.forceCodeSigning=false -c.mac.notarize=false`

Expected: an arm64 unpacked `.app` is produced for smoke testing; `pnpm verify:package -- <app-path>` PASSes and finds no Provider binary.

Run on a signing host: `pnpm package:mac:arm64 && pnpm verify:mac -- release/mac-arm64/Branchestra.app arm64`

Expected: signature, notarization ticket, Gatekeeper, architecture, and content checks all PASS. Repeat with `package:mac:x64` and `x64` on Intel hardware.

- [ ] **Step 7: Commit macOS packaging**

```bash
git add electron-builder.config.mjs build/entitlements.mac.plist build/entitlements.mac.inherit.plist scripts/validate-release-config.mjs scripts/verify-macos-artifact.sh tests/unit/scripts/validate-release-config.test.ts package.json pnpm-lock.yaml
git commit -m "build: package signed macOS releases"
```

### Task 8: Publish GitHub assets and an architecture-aware Homebrew Cask

**Files:**
- Create: `scripts/render-homebrew-cask.mjs`
- Create: `scripts/render-install-section.mjs`
- Create: `tests/unit/scripts/render-homebrew-cask.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `README.md`
- Create: `SECURITY.md`
- Create: `PRIVACY.md`
- Create: `CONTRIBUTING.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: signed DMG/ZIP assets named by Task 7, a stable-semver release tag, repository variable `BRANCHESTRA_BUNDLE_ID`, secrets for Developer ID/notarization, and a fine-scoped `HOMEBREW_TAP_TOKEN` for the repository computed as `${BRANCHESTRA_GITHUB_OWNER}/homebrew-tap`.
- Produces: GitHub Release assets, `dist/homebrew/branchestra.rb`, an owner-specific `brew install --cask "${BRANCHESTRA_GITHUB_OWNER}/tap/branchestra"` command, and `brew upgrade --cask branchestra`.

- [ ] **Step 1: Write the failing Cask-renderer test**

```ts
// tests/unit/scripts/render-homebrew-cask.test.ts
import { expect, it } from "vitest";
import { renderCask } from "../../../scripts/render-homebrew-cask.mjs";

it("selects a distinct notarized DMG and checksum for each CPU", () => {
  const cask = renderCask({
    owner: "example",
    version: "1.2.3",
    arm64Sha256: "a".repeat(64),
    x64Sha256: "b".repeat(64),
  });
  expect(cask).toContain('on_arm do');
  expect(cask).toContain('Branchestra-1.2.3-mac-arm64.dmg');
  expect(cask).toContain('Branchestra-1.2.3-mac-x64.dmg');
  expect(cask).toContain('app "Branchestra.app"');
  expect(cask).not.toContain("auto_updates true");
});
```

- [ ] **Step 2: Run the Cask test and verify it fails**

Run: `pnpm vitest run tests/unit/scripts/render-homebrew-cask.test.ts`

Expected: FAIL because `render-homebrew-cask.mjs` does not exist.

- [ ] **Step 3: Implement deterministic Cask rendering**

```js
// scripts/render-homebrew-cask.mjs
import { pathToFileURL } from "node:url";

export function renderCask({ owner, version, arm64Sha256, x64Sha256 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Version must be stable semver");
  if (![arm64Sha256, x64Sha256].every((value) => /^[a-f0-9]{64}$/.test(value))) throw new Error("Checksums must be SHA-256 hex");
  return `cask "branchestra" do
  version "${version}"
  on_arm do
    sha256 "${arm64Sha256}"
    url "https://github.com/${owner}/branchestra/releases/download/v#{version}/Branchestra-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "${x64Sha256}"
    url "https://github.com/${owner}/branchestra/releases/download/v#{version}/Branchestra-#{version}-mac-x64.dmg"
  end
  name "Branchestra"
  desc "Local-first orchestration workspace for coding agents"
  homepage "https://github.com/${owner}/branchestra"
  depends_on macos: ">= :monterey"
  app "Branchestra.app"
end
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { parseArgs } = await import("node:util");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { values } = parseArgs({
    options: {
      owner: { type: "string" },
      version: { type: "string" },
      "arm64-sha256": { type: "string" },
      "x64-sha256": { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.owner || !values.version || !values["arm64-sha256"] || !values["x64-sha256"] || !values.output) {
    throw new Error("owner, version, both checksums, and output are required");
  }
  const output = path.resolve(values.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, renderCask({
    owner: values.owner,
    version: values.version,
    arm64Sha256: values["arm64-sha256"],
    x64Sha256: values["x64-sha256"],
  }), { encoding: "utf8", flag: "wx" });
}
```

- [ ] **Step 4: Add CI with deterministic tests and unsigned packaged smoke**

```yaml
# .github/workflows/ci.yml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  workflow-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint GitHub Actions workflows
        uses: docker://rhysd/actionlint:1.7.12
  test:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.15.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24.18.0, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm test:security
      - run: pnpm build
      - run: pnpm playwright test
      - run: BRANCHESTRA_BUNDLE_ID=com.example.branchestra BRANCHESTRA_GITHUB_OWNER=example CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --config electron-builder.config.mjs --mac dir --arm64 -c.mac.forceCodeSigning=false -c.mac.notarize=false
      - run: pnpm verify:package -- release/mac-arm64/Branchestra.app
```

- [ ] **Step 5: Add the protected release workflow**

```yaml
# .github/workflows/release.yml (core job matrix)
name: Release
on:
  push:
    tags: ["v[0-9]+.[0-9]+.[0-9]+"]
permissions:
  contents: write
jobs:
  build:
    strategy:
      matrix:
        include:
          - arch: arm64
            runner: macos-15
          - arch: x64
            runner: macos-15-intel
    runs-on: ${{ matrix.runner }}
    environment: release
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 11.15.1 }
      - uses: actions/setup-node@v4
        with: { node-version: 24.18.0, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint && pnpm test && pnpm test:security && pnpm verify:release-policy
      - run: pnpm package:mac:${{ matrix.arch }}
        env:
          BRANCHESTRA_BUNDLE_ID: ${{ vars.BRANCHESTRA_BUNDLE_ID }}
          BRANCHESTRA_GITHUB_OWNER: ${{ github.repository_owner }}
          CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      - run: pnpm verify:mac -- release/mac-${{ matrix.arch }}/Branchestra.app ${{ matrix.arch }}
      - uses: actions/upload-artifact@v4
        with:
          name: mac-${{ matrix.arch }}
          path: |
            release/*-${{ matrix.arch }}.dmg
            release/*-${{ matrix.arch }}.zip
```

Add a `publish` job that downloads both artifacts, computes SHA-256 values, creates the tagged GitHub Release with every DMG/ZIP path, renders `dist/homebrew/branchestra.rb`, checks out `${{ github.repository_owner }}/homebrew-tap` with `HOMEBREW_TAP_TOKEN`, replaces only `Casks/branchestra.rb`, runs `brew audit --cask --online branchestra`, commits, and pushes. The job must depend on both native build jobs and use the protected `release` environment.

Use this complete job, with `scripts/render-homebrew-cask.mjs` exposing a CLI that accepts `--owner`, `--version`, `--arm64-sha256`, `--x64-sha256`, and `--output` in addition to the exported pure function:

```yaml
  publish:
    needs: build
    runs-on: macos-15
    environment: release
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          pattern: mac-*
          path: dist-assets
          merge-multiple: true
      - name: Verify tag and create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          version="${GITHUB_REF_NAME#v}"
          test "v${version}" = "$GITHUB_REF_NAME"
          arm_dmg="dist-assets/Branchestra-${version}-mac-arm64.dmg"
          x64_dmg="dist-assets/Branchestra-${version}-mac-x64.dmg"
          test -f "$arm_dmg"
          test -f "$x64_dmg"
          shasum -a 256 "$arm_dmg" "$x64_dmg"
          gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes dist-assets/*.dmg dist-assets/*.zip
      - name: Render Homebrew Cask
        run: |
          set -euo pipefail
          version="${GITHUB_REF_NAME#v}"
          arm_sha="$(shasum -a 256 "dist-assets/Branchestra-${version}-mac-arm64.dmg" | awk '{print $1}')"
          x64_sha="$(shasum -a 256 "dist-assets/Branchestra-${version}-mac-x64.dmg" | awk '{print $1}')"
          node scripts/render-homebrew-cask.mjs \
            --owner "$GITHUB_REPOSITORY_OWNER" \
            --version "$version" \
            --arm64-sha256 "$arm_sha" \
            --x64-sha256 "$x64_sha" \
            --output dist/homebrew/branchestra.rb
      - uses: actions/checkout@v4
        with:
          repository: ${{ github.repository_owner }}/homebrew-tap
          token: ${{ secrets.HOMEBREW_TAP_TOKEN }}
          path: homebrew-tap
      - name: Audit and publish Cask
        working-directory: homebrew-tap
        run: |
          set -euo pipefail
          install -m 0644 ../dist/homebrew/branchestra.rb Casks/branchestra.rb
          brew audit --cask --online branchestra
          git config user.name "branchestra-release-bot"
          git config user.email "branchestra-release-bot@users.noreply.github.com"
          git add Casks/branchestra.rb
          git diff --cached --check
          git commit -m "chore: update branchestra ${GITHUB_REF_NAME}"
          git push
```

- [ ] **Step 6: Document install, privacy, trust boundaries, and contribution rules**

```js
// scripts/render-install-section.mjs
export function renderInstallSection(githubOwner) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubOwner)) {
    throw new Error("A validated GitHub owner is required for installation documentation");
  }
  return `## Install on macOS

\`\`\`bash
brew install --cask ${githubOwner}/tap/branchestra
\`\`\`

Branchestra is a third-party local desktop app. Install and sign in to supported official Provider CLIs separately. Branchestra stores workflow data locally, but context selected for an Agent run is sent by that official CLI to its Provider. Public Claude subscription support remains unavailable until Anthropic approval is recorded in the repository policy gate.`;
}
```

The implementation command reads the same validated `BRANCHESTRA_GITHUB_OWNER` value used by release configuration and writes the returned section into `README.md`; it fails instead of emitting an owner-free command. `SECURITY.md` must state that worktrees are concurrency isolation rather than a malicious-repository security boundary. `PRIVACY.md` must enumerate local SQLite/events/logs, Provider-transmitted context, no telemetry, and opt-in diagnostic fields. `CONTRIBUTING.md` must describe exact pinned tools, `pnpm test`, mock-only CI credentials, event-fixture redaction, and the rule against committing consumer OAuth material.

- [ ] **Step 7: Run release-script tests and workflow lint checks**

Install the official workflow checker once on the release-maintainer Mac with `brew install actionlint`; `CONTRIBUTING.md` pins the reviewed release to `1.7.12` and requires `actionlint -version` to match before a tag. Public CI independently runs the official `rhysd/actionlint:1.7.12` image in the `workflow-lint` job—never `latest` and never an npm wrapper package.

Run: `pnpm vitest run tests/unit/scripts/render-homebrew-cask.test.ts tests/unit/scripts/validate-release-config.test.ts tests/unit/scripts/verify-release-policy.test.ts && actionlint .github/workflows/ci.yml .github/workflows/release.yml`

Expected: Cask output contains both architectures; release config and policy gates behave as specified; both workflows pass `actionlint`.

- [ ] **Step 8: Commit open-source release automation**

```bash
git add scripts/render-homebrew-cask.mjs scripts/render-install-section.mjs tests/unit/scripts/render-homebrew-cask.test.ts .github/workflows/ci.yml .github/workflows/release.yml README.md SECURITY.md PRIVACY.md CONTRIBUTING.md package.json pnpm-lock.yaml
git commit -m "ci: publish notarized Homebrew releases"
```

### Task 9: Prove the complete release candidate and recovery story

**Files:**
- Create: `e2e/release-candidate.spec.ts`
- Create: `src/main/testing/e2e-controls.ts`
- Create: `tests/unit/main/e2e-controls.test.ts`
- Create: `docs/release-checklist.md`
- Create: `docs/support-matrix.md`
- Modify: `src/main/worker/supervisor.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: every milestone test, the packaged app, Provider policy records, enforcement reports, and release assets.
- Produces: `pnpm verify:all`, a completed per-version release checklist, and an explicit public support matrix.

- [ ] **Step 1: Write the failing end-to-end release-candidate journey**

```ts
// e2e/release-candidate.spec.ts
import { expect, test } from "@playwright/test";
import { launchPackagedTestApp } from "./support/launch-test-app.js";

test("packaged app preserves a reviewed task across a worker crash and restart", async () => {
  const app = await launchPackagedTestApp({ provider: "mock", repoFixture: "two-agent-clean" });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Add project" }).click();
  await page.getByRole("button", { name: "Create room" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("@Codex implement the fixture change and invite Claude to review");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Approve task scope" }).click();
  await expect(page.getByText("Round 1 review complete")).toBeVisible();
  await app.evaluate(() => (globalThis as { __branchestraE2E?: { crashWorker(): void } }).__branchestraE2E?.crashWorker());
  await expect(page.getByText("Worker restarted; state reconciled")).toBeVisible();
  await expect(page.getByText("Awaiting final merge approval")).toBeVisible();
  await page.getByRole("button", { name: "Approve final merge" }).click();
  await expect(page.getByText("Completed")).toBeVisible();
  await app.close();
});
```

- [ ] **Step 2: Run the packaged journey before wiring the aggregate command**

Run: `pnpm playwright test e2e/release-candidate.spec.ts`

Expected: FAIL until the packaged-app launcher, worker-crash test hook restricted to `BRANCHESTRA_E2E=1`, and expected trusted timeline labels are connected.

- [ ] **Step 3: Wire the test-only crash hook and aggregate verification**

```json
{
  "scripts": {
    "verify:all": "pnpm typecheck && pnpm lint && pnpm test && pnpm test:security && pnpm build && pnpm playwright test && pnpm verify:release-policy && pnpm licenses:check"
  }
}
```

The Main crash hook must be registered only when `process.env.BRANCHESTRA_E2E === "1"`; production builds must have a unit test proving the channel is absent. The packaged launcher supplies a temporary `userData` directory and mock external CLI paths, then verifies the real ASAR and utility-worker entry rather than launching source files.

```ts
// src/main/worker/supervisor.ts (Task 9 delta)
// Extend the existing interface and implementation with an internal-only crash seam.
export interface WorkerSupervisor {
  // ...the Milestone 1 methods remain unchanged...
  forceCrashForTest(): void;
}
// The implementation kills only the currently verified utility child and lets
// the existing unexpected-exit/restart path perform normal reconciliation.
```

```ts
// src/main/testing/e2e-controls.ts
import type { WorkerSupervisor } from "../worker/supervisor.js";

declare global {
  // Test-only Main-process control; never exposed through Preload or IPC.
  var __branchestraE2E: { crashWorker(): void } | undefined;
}

export function installE2EControls(environment: NodeJS.ProcessEnv, supervisor: WorkerSupervisor): void {
  delete globalThis.__branchestraE2E;
  if (environment.BRANCHESTRA_E2E !== "1") return;
  globalThis.__branchestraE2E = {
    crashWorker: () => supervisor.forceCrashForTest(),
  };
}
```

```ts
// tests/unit/main/e2e-controls.test.ts
import { expect, it } from "vitest";
import { installE2EControls } from "../../../src/main/testing/e2e-controls.js";
import type { WorkerSupervisor } from "../../../src/main/worker/supervisor.js";

function fakeSupervisor(): WorkerSupervisor {
  return { forceCrashForTest() {} } as WorkerSupervisor;
}

it("does not install Main-process controls in a production environment", () => {
  installE2EControls({ NODE_ENV: "production" }, fakeSupervisor());
  expect(globalThis.__branchestraE2E).toBeUndefined();
});
```

- [ ] **Step 4: Write the exact release evidence checklist and support matrix**

```markdown
<!-- docs/release-checklist.md -->
# Release Checklist

- [ ] Tag is stable semver and points to a green `main` commit.
- [ ] Provider policy review is at most 30 days old; enabled flags match its decisions.
- [ ] Anthropic written approval evidence exists if and only if public Claude subscription support is enabled.
- [ ] Unit, integration, security matrix, Electron E2E, and packaged recovery journey pass.
- [ ] arm64 artifact passes `codesign`, `stapler`, `spctl`, package-content scan, and native smoke on `macos-15`.
- [ ] x64 artifact passes the same checks and native smoke on `macos-15-intel`.
- [ ] DMG/ZIP SHA-256 values match GitHub assets and the Homebrew Cask.
- [ ] `brew audit --cask --online branchestra` and clean-machine install/upgrade pass.
- [ ] No consumer OAuth credential, Provider executable, source map, source repository, or raw Provider fixture is present in assets.
- [ ] Manual real-Provider smoke evidence is attached for each Provider marked public-supported; unsupported Providers are visibly disabled.
```

`docs/support-matrix.md` must contain one row per `(app version, Provider, SDK version, exact CLI version, macOS architecture)` with auth mode, streaming/resume/sandbox/network capabilities, enforcement profile hash, policy status, fixture version, and last controlled smoke date. The app reads a generated JSON copy and fails closed for a missing row.

- [ ] **Step 5: Run the complete verification suite**

Run: `pnpm verify:all`

Expected: typecheck, lint, unit, integration, the explicit negative security matrix, all Electron E2E, policy, and license checks PASS with no skipped release-blocking test.

Run on each packaged architecture: `pnpm verify:mac -- <absolute-path-to-Branchestra.app> <arm64-or-x64>`

Expected: signature, stapling, Gatekeeper, exact architecture, and package-content verification PASS.

- [ ] **Step 6: Commit release evidence and final verification**

```bash
git add e2e/release-candidate.spec.ts src/main/testing/e2e-controls.ts src/main/worker/supervisor.ts tests/unit/main/e2e-controls.test.ts docs/release-checklist.md docs/support-matrix.md package.json
git commit -m "test: verify complete Branchestra release candidate"
```

## Milestone Exit Criteria

- All untrusted content remains inert and cannot navigate, open a window without native confirmation, forge approval UI, or invoke a privileged IPC route.
- Oversize, malformed, subframe, duplicate, and stale-generation IPC requests fail closed; restart replay remains monotonic and deduplicated.
- Every public-supported Provider/CLI/architecture row has a passing enforcement profile; a missing or changed result prevents a run.
- Cancellation and Quit terminate verified Provider/test process groups within the configured deadline and leave one durable workflow owner.
- Logs and exported diagnostics contain no tokens, auth output, source bodies, raw diffs, or environment values; diagnostic export is explicit and permission-restricted.
- Public Claude subscription support is disabled unless written Anthropic approval is checked in and policy-valid; no API fallback or bundled Provider executable exists.
- Separate arm64 and x64 DMG/ZIP artifacts pass native packaged smoke, Developer ID verification, notarization/stapling, Gatekeeper, package scan, and checksum checks.
- GitHub Releases and the architecture-aware Cask install and upgrade Branchestra from a terminal; no second auto-update mechanism is present.
