import type { AgentProvider } from "../../shared/contracts/domain";

export function parseAgentMentions(text: string): AgentProvider[] {
  const withoutInlineCode = text.replace(/`[^`\n]*`/g, " ");
  const matches = withoutInlineCode.matchAll(/(^|[^\p{L}\p{N}_@])@(Claude|Codex)\b/giu);
  return [...new Set(
    [...matches].map((match) => match[2]!.toLowerCase() as AgentProvider)
  )];
}
