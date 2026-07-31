import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { redactValue } from "./redactor";

export interface DiagnosticInput {
  appVersion: string;
  platform: { os: string; arch: string; electron: string; node: string };
  providerHealth: unknown;
  taskStateCounts: Record<string, number>;
  recentErrors: unknown[];
}
export async function exportDiagnosticBundle(input: DiagnosticInput, destination: string): Promise<{ sha256: string; bytes: number }> {
  const payload = Buffer.from(JSON.stringify(redactValue({ schemaVersion: 1, exportedAt: new Date().toISOString(), ...input }), null, 2));
  const compressed = gzipSync(payload, { level: 9 });
  await writeFile(destination, compressed, { mode: 0o600, flag: "wx" });
  return { sha256: createHash("sha256").update(compressed).digest("hex"), bytes: compressed.byteLength };
}
