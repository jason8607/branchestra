import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

describe("Provider Git source boundary", () => {
  it("does not expose the Git mutation or process/storage boundaries to Provider modules", async () => {
    const sourceRoot = resolve("src/worker");
    const providersRoot = join(sourceRoot, "providers");
    const violations: string[] = [];
    for (const file of await typescriptFiles(providersRoot)) {
      const source = await readFile(file, "utf8");
      const importPattern = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
      const sideEffectImportPattern = /\bimport\s*["']([^"']+)["']/g;
      const specifiers = [
        ...source.matchAll(importPattern),
        ...source.matchAll(sideEffectImportPattern)
      ].map((match) => match[1] ?? "");
      for (const specifier of specifiers) {
        const resolved = specifier.startsWith(".") ? resolve(dirname(file), specifier) : specifier;
        if (specifier === "node:child_process"
          || resolved === join(sourceRoot, "git", "git-manager")
          || resolved === join(sourceRoot, "git", "git-command-runner")
          || resolved === join(sourceRoot, "operations", "journaled-operation-runner")
          || resolved === join(sourceRoot, "operations", "repository-lock")
          || resolved === join(sourceRoot, "storage")
          || resolved.startsWith(`${join(sourceRoot, "storage")}/`)) {
          violations.push(`${relative(sourceRoot, file)} imports ${specifier}`);
        }
      }
      if (/\bexport\b[^\n]*(?:worktree\s+add|update-ref|commit|merge|reset|clean|stash)/i.test(source)) {
        violations.push(`${relative(sourceRoot, file)} exports a mutating Git command`);
      }
    }
    expect(violations).toEqual([]);
  });
});
