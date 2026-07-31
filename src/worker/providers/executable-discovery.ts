import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "../../shared/contracts/provider";
import type { ProviderExecPort } from "./provider-exec-port";
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
  const providerSpecific = provider === "claude" ? [join(homeDirectory, ".claude", "local", name)] : [];
  return [...providerSpecific, join(homeDirectory, ".local", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
}

export function parseProviderCliVersion(provider: ProviderId, stdout: string): string {
  const pattern = provider === "claude" ? /(?:claude(?: code)?\s+)?(\d+\.\d+\.\d+)/i : /(?:codex-cli\s+)?(\d+\.\d+\.\d+)/i;
  const match = pattern.exec(stdout.trim());
  if (!match) throw new Error(`Unrecognized ${provider} version output`);
  return match[1]!;
}

export async function discoverExternalExecutable(input: {
  provider: ProviderId;
  selectedPath: string | null;
  homeDirectory: string;
  architecture: "arm64" | "x64";
  runner: ProviderExecPort;
}): Promise<DetectedExecutable | null> {
  const candidates = input.selectedPath
    ? [input.selectedPath, ...executableCandidates(input.provider, input.homeDirectory)]
    : executableCandidates(input.provider, input.homeDirectory);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const canonical = await realpath(candidate);
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      const result = await input.runner(canonical, ["--version"], {
        env: { HOME: input.homeDirectory, LANG: "C", LC_ALL: "C" },
        timeoutMs: 5_000,
        maxBufferBytes: 65_536,
      });
      const cliVersion = parseProviderCliVersion(input.provider, result.stdout);
      const support = evaluateSupport({ provider: input.provider, sdkVersion: sdkVersions[input.provider], cliVersion, architecture: input.architecture });
      if (!support.supported) continue;
      return { provider: input.provider, executableRealpath: canonical, cliVersion, architecture: input.architecture };
    } catch {
      continue;
    }
  }
  return null;
}
