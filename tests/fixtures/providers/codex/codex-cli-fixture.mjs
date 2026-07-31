#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const capture = process.env.BRANCHESTRA_CODEX_ARGV_CAPTURE;
if (!capture) throw new Error("BRANCHESTRA_CODEX_ARGV_CAPTURE is required");
writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort() }));
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-fixture-1" })}\n`);
process.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })}\n`);
