import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface BoundaryScan {
  visited: string[];
  violations: string[];
}

async function resolveLocalImport(fromFile: string, specifier: string): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return null;
}

async function scanProviderGraph(workerRoot: string): Promise<BoundaryScan> {
  const entry = join(workerRoot, "providers", "provider-entry.ts");
  const readPort = join(workerRoot, "providers", "provider-git-read-port.ts");
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (visited.has(file)) continue;
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        violations.push(`ENTRY_OR_IMPORT_MISSING:${relative(workerRoot, file)}`);
        continue;
      }
      throw error;
    }
    visited.add(file);
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    for (const statement of sourceFile.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || statement.moduleSpecifier === undefined
        || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const typeOnly = ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly === true
        : statement.isTypeOnly;
      if (specifier === "node:child_process") {
        violations.push(`${relative(workerRoot, file)} imports node:child_process`);
        continue;
      }
      const resolved = await resolveLocalImport(file, specifier);
      if (specifier.startsWith(".") && resolved === null) {
        violations.push(`UNRESOLVED_LOCAL_IMPORT:${relative(workerRoot, file)}:${specifier}`);
        continue;
      }
      if (resolved === null) continue;
      const relativeTarget = relative(workerRoot, resolved);
      if (relativeTarget === "git/git-manager.ts"
        || relativeTarget === "git/git-command-runner.ts"
        || relativeTarget === "operations/journaled-operation-runner.ts"
        || relativeTarget === "operations/repository-lock.ts"
        || relativeTarget === "storage"
        || relativeTarget.startsWith("storage/")) {
        violations.push(`${relative(workerRoot, file)} reaches ${relativeTarget}`);
      }
      if (relativeTarget === "git/repository-inspector.ts"
        && (file !== readPort || !typeOnly)) {
        violations.push(`${relative(workerRoot, file)} bypasses the type-only Git read port`);
      }
      if (file === entry && resolved === readPort && !typeOnly) {
        violations.push("provider-entry.ts imports the Git read port as a value");
      }
      if (relativeTarget !== "git/repository-inspector.ts") pending.push(resolved);
    }
    if (/\bexport\b[\s\S]*?(?:worktree\s+add|update-ref|\bcommit\b|\bmerge\b|\breset\b|\bclean\b|\bstash\b)/i
      .test(source)) {
      violations.push(`${relative(workerRoot, file)} exports a mutating Git command`);
    }
  }

  if (!visited.has(entry)) violations.push("PROVIDER_ENTRY_REQUIRED");
  if (!visited.has(readPort)) violations.push("PROVIDER_GIT_READ_PORT_REQUIRED");
  return {
    visited: [...visited].map((file) => relative(workerRoot, file)).sort(),
    violations
  };
}

describe("Provider Git source boundary", () => {
  it("walks the actual Provider entry graph through a dedicated type-only Git read port", async () => {
    const workerRoot = resolve("src/worker");
    const result = await scanProviderGraph(workerRoot);

    expect(result.violations).toEqual([]);
    expect(result.visited).toContain("providers/provider-entry.ts");
    expect(result.visited).toContain("providers/provider-git-read-port.ts");
    await expect(readFile(
      join(workerRoot, "providers", "provider-git-read-port.ts"),
      "utf8"
    )).resolves.toMatch(/export type ProviderGitReadPort\s*=\s*Pick<\s*GitReadService/);
  });

  it("rejects forbidden authority hidden behind a transitive intermediary", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-provider-boundary-"));
    const workerRoot = join(root, "src", "worker");
    try {
      await Promise.all([
        mkdir(join(workerRoot, "providers"), { recursive: true }),
        mkdir(join(workerRoot, "context"), { recursive: true }),
        mkdir(join(workerRoot, "git"), { recursive: true }),
        mkdir(join(workerRoot, "storage"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(workerRoot, "providers", "provider-entry.ts"), [
          "import type { ProviderGitReadPort } from './provider-git-read-port';",
          "import type { HiddenAuthority } from '../context/hidden-authority';",
          "export interface ProviderEntry { git: ProviderGitReadPort; hidden: HiddenAuthority }"
        ].join("\n")),
        writeFile(join(workerRoot, "providers", "provider-git-read-port.ts"), [
          "import type { GitReadService } from '../git/repository-inspector';",
          "export type ProviderGitReadPort = Pick<GitReadService, 'status'>;"
        ].join("\n")),
        writeFile(join(workerRoot, "context", "hidden-authority.ts"),
          "import type { Database } from '../storage/database';\nexport type HiddenAuthority = Database;\n"),
        writeFile(join(workerRoot, "git", "repository-inspector.ts"),
          "export interface GitReadService { status(): Promise<void> }\n"),
        writeFile(join(workerRoot, "storage", "database.ts"),
          "export interface Database { close(): void }\n")
      ]);

      const result = await scanProviderGraph(workerRoot);
      expect(result.visited).toContain("context/hidden-authority.ts");
      expect(result.violations).toContain(
        "context/hidden-authority.ts reaches storage/database.ts"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
