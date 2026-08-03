import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const ManifestSchema = z.object({
  schemaVersion: z.literal(1), cliVersion: z.enum(["0.144.6", "0.145.0"]),
  repositoryPath: z.string().min(1), packagedRelativePath: z.string().min(1),
  bytes: z.number().int().positive().max(524_288), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

type CodexConfigLockRealpath = string & { readonly __codexConfigLock: unique symbol };
export type ValidatedCodexConfigLock =
  | { valid: true; realpath: CodexConfigLockRealpath; sha256: string }
  | { valid: false; reason: string };

export const CURRENT_PRIVATE_CODEX_CLI_VERSION = "0.145.0";

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

export async function validateCodexSubscriptionConfigLock(input: {
  resourcesRootRealpath: string;
  expectedCliVersion: string;
  manifestPath?: string;
}): Promise<ValidatedCodexConfigLock> {
  try {
    const root = await realpath(input.resourcesRootRealpath);
    const manifestPath = input.manifestPath ?? resolve(root, "codex-config-lock-manifest.json");
    const canonicalManifest = await realpath(manifestPath);
    if (!inside(root, canonicalManifest)) throw new Error("Codex config lock manifest escaped application resources");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("Codex config lock manifest must be a regular non-symlink file");
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(canonicalManifest, "utf8")));
    if (input.expectedCliVersion !== manifest.cliVersion) throw new Error("Codex CLI version does not match reviewed config lock");
    const expectedRepositoryPath = `resources/codex/${manifest.cliVersion}/subscription.config.lock.toml`;
    const expectedPackagedPath = `codex/${manifest.cliVersion}/subscription.config.lock.toml`;
    if (manifest.repositoryPath !== expectedRepositoryPath || manifest.packagedRelativePath !== expectedPackagedPath) {
      throw new Error("Codex config lock path does not match manifest version");
    }
    const isPackagedLayout = canonicalManifest === resolve(root, "codex-config-lock-manifest.json");
    const requested = resolve(root, isPackagedLayout ? manifest.packagedRelativePath : manifest.repositoryPath);
    const canonical = await realpath(requested);
    if (!inside(root, canonical)) throw new Error("Codex config lock escaped application resources");
    const info = await lstat(requested);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Codex config lock must be a regular non-symlink file");
    if (info.size !== manifest.bytes || info.size > 524_288) throw new Error("Codex config lock size does not match manifest");
    const bytes = await readFile(canonical);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (hash !== manifest.sha256) throw new Error("Codex config lock hash does not match manifest");
    const body = bytes.toString("utf8");
    const escapedVersion = manifest.cliVersion.replaceAll(".", "\\.");
    if (!/^version\s*=\s*1\s*$/m.test(body) || !new RegExp(`^codex_version\\s*=\\s*"${escapedVersion}"\\s*$`, "m").test(body)) {
      throw new Error("Codex config lock version is invalid");
    }
    const forbidden = /(?:^\s*(?:api[_-]?key|access_token|auth_token|authorization|password)\s*=|^\s*model_provider\s*=\s*"(?!openai")|^\s*(?:chatgpt_|openai_)?base_url\s*=\s*"(?!https:\/\/chatgpt\.com\/backend-api\/codex")|^\s*\[config\.mcp_servers\.[^\]]+\]|^\s*\[config\.hooks?(?:\.|\])|^\s*notify\s*=|^\s*allow_codex_version_mismatch\s*=\s*true)/im;
    if (forbidden.test(body)) throw new Error("Codex config lock contains forbidden configuration");
    return { valid: true, realpath: canonical as CodexConfigLockRealpath, sha256: hash };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : "Codex config lock is invalid" };
  }
}
