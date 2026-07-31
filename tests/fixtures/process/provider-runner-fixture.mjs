import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "stubborn-grandchild.mjs")], { stdio: "ignore" });
process.stdout.write(`${JSON.stringify({ type: "fixture.grandchild", pid: child.pid })}\n`);
process.on("SIGTERM", () => {});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) { void line; /* intentionally ignore protocol abort */ }
