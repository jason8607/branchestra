const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|base[_-]?url|bedrock|vertex|foundry)/i;
const SECRET_TEXT = /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})/gi;

export function redactText(text: string): string {
  return text.replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: [REDACTED]").replace(SECRET_TEXT, "[REDACTED]");
}
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(child)]));
  }
  return value;
}
