import type { ProviderId } from "../../shared/contracts/provider";

export interface SupportTuple {
  provider: ProviderId;
  sdkVersion: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
}

const SUPPORTED = new Set([
  "claude:0.3.216:2.1.206:arm64",
  "claude:0.3.216:2.1.206:x64",
  "codex:0.144.6:0.144.6:arm64",
  "codex:0.144.6:0.144.6:x64",
]);

export function evaluateSupport(input: SupportTuple):
  | { supported: true }
  | { supported: false; reason: string } {
  const key = `${input.provider}:${input.sdkVersion}:${input.cliVersion}:${input.architecture}`;
  if (SUPPORTED.has(key)) return { supported: true };
  const name = input.provider === "claude" ? "Claude" : "Codex";
  return { supported: false, reason: `Unsupported ${name} CLI ${input.cliVersion} for SDK ${input.sdkVersion} on ${input.architecture}` };
}
