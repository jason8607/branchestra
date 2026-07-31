import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface BoundaryScan {
  visited: string[];
  violations: string[];
}

interface ImportEdge {
  specifier: string;
  typeOnly: boolean;
}

async function typescriptFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const nested = await Promise.all(entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? typescriptFiles(path)
        : Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }));
    return nested.flat();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
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

function importEdges(sourceFile: ts.SourceFile, relativeFile: string, violations: string[]): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const statement of sourceFile.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || statement.moduleSpecifier === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    edges.push({
      specifier: statement.moduleSpecifier.text,
      typeOnly: ts.isImportDeclaration(statement)
        ? statement.importClause?.isTypeOnly === true
        : statement.isTypeOnly
    });
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument === undefined || !ts.isStringLiteralLike(argument)) {
        violations.push(`${relativeFile} uses a non-literal dynamic module edge`);
      } else {
        edges.push({ specifier: argument.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return edges;
}

async function scanProviderGraph(workerRoot: string): Promise<BoundaryScan> {
  const entry = join(workerRoot, "providers", "provider-entry.ts");
  const readPort = join(workerRoot, "providers", "provider-git-read-port.ts");
  const pending = await typescriptFiles(join(workerRoot, "providers"));
  if (!pending.includes(entry)) pending.push(entry);
  const visited = new Set<string>();
  const violations: string[] = [];
  let entryImportsReadPort = false;

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
    const relativeFile = relative(workerRoot, file);
    for (const { specifier, typeOnly } of importEdges(sourceFile, relativeFile, violations)) {
      if (specifier === "node:child_process" || specifier === "child_process") {
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
      if (file === entry && resolved === readPort && typeOnly) entryImportsReadPort = true;
      if (relativeTarget !== "git/repository-inspector.ts") pending.push(resolved);
    }
    if (/\bexport\b[\s\S]*?(?:worktree\s+add|update-ref|\bcommit\b|\bmerge\b|\breset\b|\bclean\b|\bstash\b)/i
      .test(source)) {
      violations.push(`${relative(workerRoot, file)} exports a mutating Git command`);
    }
  }

  if (!visited.has(entry)) violations.push("PROVIDER_ENTRY_REQUIRED");
  if (!visited.has(readPort)) violations.push("PROVIDER_GIT_READ_PORT_REQUIRED");
  if (!entryImportsReadPort) violations.push("PROVIDER_ENTRY_READ_PORT_CONTRACT_REQUIRED");
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

  it("scans malicious orphan Provider modules that are not reachable from the entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-provider-orphan-"));
    const workerRoot = join(root, "src", "worker");
    try {
      await Promise.all([
        mkdir(join(workerRoot, "providers"), { recursive: true }),
        mkdir(join(workerRoot, "git"), { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(workerRoot, "providers", "provider-entry.ts"),
          "import type { ProviderGitReadPort } from './provider-git-read-port';\nexport interface ProviderEntry { git: ProviderGitReadPort }\n"),
        writeFile(join(workerRoot, "providers", "provider-git-read-port.ts"),
          "import type { GitReadService } from '../git/repository-inspector';\nexport type ProviderGitReadPort = Pick<GitReadService, 'status'>;\n"),
        writeFile(join(workerRoot, "providers", "orphan-provider.ts"),
          "export { GitManager } from '../git/git-manager';\n"),
        writeFile(join(workerRoot, "git", "repository-inspector.ts"),
          "export interface GitReadService { status(): Promise<void> }\n"),
        writeFile(join(workerRoot, "git", "git-manager.ts"),
          "export class GitManager {}\n")
      ]);

      const result = await scanProviderGraph(workerRoot);
      expect(result.visited).toContain("providers/orphan-provider.ts");
      expect(result.violations).toContain(
        "providers/orphan-provider.ts reaches git/git-manager.ts"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dynamic import and CommonJS require authority behind a reachable intermediary", async () => {
    const root = await mkdtemp(join(tmpdir(), "branchestra-provider-dynamic-"));
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
          "import { loadHiddenAuthority } from '../context/dynamic-hidden-authority';",
          "export interface ProviderEntry { git: ProviderGitReadPort }",
          "export const load = loadHiddenAuthority;"
        ].join("\n")),
        writeFile(join(workerRoot, "providers", "provider-git-read-port.ts"),
          "import type { GitReadService } from '../git/repository-inspector';\nexport type ProviderGitReadPort = Pick<GitReadService, 'status'>;\n"),
        writeFile(join(workerRoot, "context", "dynamic-hidden-authority.ts"), [
          "export async function loadHiddenAuthority() {",
          "  await import('../storage/database');",
          "  await import('node:child_process');",
          "  require('../git/git-manager');",
          "  require('node:child_process');",
          "}"
        ].join("\n")),
        writeFile(join(workerRoot, "git", "repository-inspector.ts"),
          "export interface GitReadService { status(): Promise<void> }\n"),
        writeFile(join(workerRoot, "git", "git-manager.ts"),
          "export class GitManager {}\n"),
        writeFile(join(workerRoot, "storage", "database.ts"),
          "export interface Database { close(): void }\n")
      ]);

      const result = await scanProviderGraph(workerRoot);
      expect(result.visited).toContain("context/dynamic-hidden-authority.ts");
      expect(result.violations).toContain(
        "context/dynamic-hidden-authority.ts reaches storage/database.ts"
      );
      expect(result.violations).toContain(
        "context/dynamic-hidden-authority.ts reaches git/git-manager.ts"
      );
      expect(result.violations).toContain(
        "context/dynamic-hidden-authority.ts imports node:child_process"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
