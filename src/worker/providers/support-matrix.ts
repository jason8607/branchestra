import type { ProviderId } from "../../shared/contracts/provider";
import rawMatrix from "../../../config/provider-support-matrix.json";

export interface SupportTuple {
  provider: ProviderId;
  sdkVersion: string;
  cliVersion: string;
  architecture: "arm64" | "x64";
}

interface MatrixRow extends SupportTuple {
  appVersion: string;
  authMode: string;
  fixtureVersion: string;
  profileHash: string | null;
  lastControlledSmoke: string | null;
  policyStatus: string;
}

function matrixRows(value: unknown): MatrixRow[] {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1
    || !Array.isArray((value as { rows?: unknown }).rows)) return [];
  return (value as { rows: unknown[] }).rows.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Partial<MatrixRow>;
    if ((row.provider !== "claude" && row.provider !== "codex")
      || (row.architecture !== "arm64" && row.architecture !== "x64")
      || !row.sdkVersion || !row.cliVersion || !row.appVersion || !row.authMode || !row.fixtureVersion
      || !row.policyStatus) return [];
    return [row as MatrixRow];
  });
}

const SUPPORTED = new Set(matrixRows(rawMatrix).map((row) =>
  `${row.provider}:${row.sdkVersion}:${row.cliVersion}:${row.architecture}`
));

export function evaluateSupport(input: SupportTuple):
  | { supported: true }
  | { supported: false; reason: string } {
  const key = `${input.provider}:${input.sdkVersion}:${input.cliVersion}:${input.architecture}`;
  if (SUPPORTED.has(key)) return { supported: true };
  const name = input.provider === "claude" ? "Claude" : "Codex";
  return { supported: false, reason: `Unsupported ${name} CLI ${input.cliVersion} for SDK ${input.sdkVersion} on ${input.architecture}` };
}
