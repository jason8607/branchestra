import type { Writable } from "node:stream";
import type { z } from "zod";

export const MAX_PROVIDER_RUNNER_LINE_BYTES = 1_048_576;

export function decodeJsonLine<T>(line: string, schema: z.ZodType<T>): T {
  if (Buffer.byteLength(line, "utf8") > MAX_PROVIDER_RUNNER_LINE_BYTES) {
    throw new Error(`Provider runner line exceeds ${MAX_PROVIDER_RUNNER_LINE_BYTES} bytes`);
  }
  return schema.parse(JSON.parse(line));
}

export async function writeJsonLine(stream: Writable, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_PROVIDER_RUNNER_LINE_BYTES) {
    throw new Error(`Provider runner line exceeds ${MAX_PROVIDER_RUNNER_LINE_BYTES} bytes`);
  }
  if (stream.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}
