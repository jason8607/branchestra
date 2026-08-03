import { expect, it } from "vitest";
import { parseAgentMentions } from "../../../src/worker/tasks/mention-parser";

it.each([
  ["@Claude fix this", ["claude"]],
  ["please ask @Codex.", ["codex"]],
  ["`@Claude` is documentation", []],
  ["email@Claude.com", []],
  ["@Claude and @Codex compare", ["claude", "codex"]],
  ["@claude, @CLAUDE, then @codex", ["claude", "codex"]],
  ["＠Claude and ＠Codex compare", ["claude", "codex"]]
])("parses supported user mentions from %s", (text, expected) => {
  expect(parseAgentMentions(text)).toEqual(expected);
});
