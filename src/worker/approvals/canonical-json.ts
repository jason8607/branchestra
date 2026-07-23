import { createHash } from "node:crypto";

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("CANONICAL_JSON_UNSUPPORTED:number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`CANONICAL_JSON_UNSUPPORTED:${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("CANONICAL_JSON_CYCLE");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encodeCanonical(item, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${encodeCanonical(item, ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encodeCanonical(value, new Set());
}

export function hashCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
