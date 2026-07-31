import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { listPackage } from "@electron/asar";

export async function verifyPackageContents(appPathInput, repoRoot = process.cwd()) {
  const appPath = path.resolve(appPathInput ?? "");
  if (!path.isAbsolute(appPathInput ?? "") || !appPath.endsWith(".app") || !fs.statSync(appPath).isDirectory()) {
    throw new Error("Expected an absolute packaged .app path");
  }
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/provider-policy.json"), "utf8"));
  if (policy.publicFeatures.codexSubscription) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "config/codex-config-lock-manifest.json"), "utf8"));
    const packagedLock = path.join(resourcesPath, manifest.packagedRelativePath);
    const bytes = fs.readFileSync(packagedLock);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== manifest.bytes || hash !== manifest.sha256) throw new Error("Packaged Codex config lock does not match the reviewed manifest");
  }
  const forbiddenExecutableName = /^(?:claude|codex)(?:\.exe)?$/i;
  const forbiddenProviderPackage = /node_modules\/(?:@openai\/codex(?:\/|-(?!sdk(?:\/|$)))|@anthropic-ai\/claude-agent-sdk\/vendor\/)/i;
  const forbiddenPath = /(?:\.env(?:\.|$)|auth\.json$|credentials|sessions\/|\.map$)/i;
  const macho = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);
  function inspect(relative, absolute, mode = 0) {
    const normalized = relative.replaceAll(path.sep, "/");
    const name = path.basename(normalized);
    const firstFour = fs.existsSync(absolute) ? fs.readFileSync(absolute).subarray(0, 4).toString("hex") : "";
    if (forbiddenExecutableName.test(name) || forbiddenProviderPackage.test(normalized) || forbiddenPath.test(normalized) || macho.has(firstFour)) {
      throw new Error(`Forbidden packaged resource: ${normalized}`);
    }
    if ((mode & 0o111) !== 0 && /(?:claude|codex)/i.test(name)) throw new Error(`Forbidden packaged executable: ${normalized}`);
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else inspect(path.relative(appPath, absolute), absolute, fs.statSync(absolute).mode);
    }
  }
  walk(resourcesPath);
  const asarPath = path.join(resourcesPath, "app.asar");
  if (fs.existsSync(asarPath)) {
    for (const entry of await listPackage(asarPath)) {
      const normalized = entry.replaceAll("\\", "/");
      if (forbiddenProviderPackage.test(normalized) || forbiddenPath.test(normalized)) throw new Error(`Forbidden ASAR entry: ${normalized}`);
    }
  }
  return true;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const appArgument = process.argv.slice(2).find((value) => value !== "--");
  await verifyPackageContents(appArgument);
}
