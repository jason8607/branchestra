import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type Page } from "@playwright/test";

export type E2EScenario = "two-round-success" | "interrupted-run";

export interface LaunchBranchestraE2EOptions {
  scenario: E2EScenario;
  repositoryRoot: string;
  userDataDir?: string;
}

export interface BranchestraE2EApp {
  userDataDir: string;
  firstWindow(): Promise<Page>;
  chooseRepository(): Promise<void>;
  readManagedWorktreeFile(relativePath: string): string;
  managedBranchExists(): Promise<boolean>;
  close(): Promise<void>;
}

function findFile(root: string, relativePath: string): string | null {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (!statSync(path).isDirectory()) continue;
    const candidate = join(path, relativePath);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      const nested = findFile(path, relativePath);
      if (nested) return nested;
    }
  }
  return null;
}

export async function launchBranchestraE2E(
  options: LaunchBranchestraE2EOptions
): Promise<BranchestraE2EApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "branchestra-task-e2e-"));
  const environment: Record<string, string> = {
    BRANCHESTRA_E2E: "1",
    BRANCHESTRA_E2E_USER_DATA: userDataDir,
    BRANCHESTRA_E2E_PROJECT_PATH: options.repositoryRoot,
    BRANCHESTRA_E2E_MOCK_SCENARIO: options.scenario
  };
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const app = await _electron.launch({ args: [process.cwd()], env: environment });
  return {
    userDataDir,
    firstWindow: () => app.firstWindow(),
    async chooseRepository() {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Add Project" }).click();
    },
    readManagedWorktreeFile(relativePath) {
      const root = join(userDataDir, "managed-worktrees");
      const path = findFile(root, relativePath);
      if (!path) throw new Error(`Managed worktree file not found: ${relativePath}`);
      return readFileSync(path, "utf8");
    },
    async managedBranchExists() {
      const { stdout } = await import("node:child_process").then(({ execFile }) =>
        new Promise<{ stdout: string }>((resolve, reject) => {
          execFile("/usr/bin/git", ["-C", options.repositoryRoot, "for-each-ref", "--format=%(refname)", "refs/heads/branchestra/"], (error, output) => {
            if (error) reject(error);
            else resolve({ stdout: output });
          });
        }));
      return stdout.trim().length > 0;
    },
    close: () => app.close()
  };
}

export async function createAndApproveTask(
  page: Page,
  app: BranchestraE2EApp,
  message: `@Claude ${string}` | `@Codex ${string}`
): Promise<void> {
  await app.chooseRepository();
  await page.getByTestId("room-title-input").fill("Task room");
  await page.getByTestId("create-room").click();
  await page.getByLabel("Message").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Open task" }).first().click();
  await page.getByTestId("task-state").waitFor({ state: "visible", timeout: 5_000 }).catch(async (error) => {
    throw new Error(`Task Inspector unavailable:\n${await page.locator("body").innerText()}`, { cause: error });
  });
  await page.getByRole("button", { name: "Approve task scope" }).click();
}
