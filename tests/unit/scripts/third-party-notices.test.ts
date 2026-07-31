import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("third-party notices", () => {
  it("contains every production dependency version and license", () => {
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("npm_execpath is required to audit production licenses");
    const report = JSON.parse(execFileSync(process.execPath, [pnpm, "licenses", "list", "--prod", "--json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })) as Record<string, Array<{ name: string; versions: string[]; license?: string }>>;
    const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
    for (const [licenseGroup, packages] of Object.entries(report)) {
      for (const pkg of packages) for (const version of pkg.versions) {
        expect(notices).toContain(`## ${pkg.name} ${version} — ${pkg.license ?? licenseGroup}`);
      }
    }
  });
});
