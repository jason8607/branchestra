import type { ThreadOptions } from "@openai/codex-sdk";

export interface ClaudeSdkModule {
  query(input: { prompt: string; options: Record<string, unknown> }): AsyncIterable<unknown> & { close(): void };
  tool(name: string, description: string, inputSchema: object, handler: (input: never) => Promise<unknown>, extras: object): unknown;
  createSdkMcpServer(options: { name: string; version: string; tools: unknown[] }): unknown;
}

export interface ClaudeSdkFactory {
  load(): Promise<ClaudeSdkModule>;
}

export const loadClaudeSdkFactory = (): ClaudeSdkFactory => ({
  load: async () => await import("@anthropic-ai/claude-agent-sdk") as unknown as ClaudeSdkModule,
});

export interface CodexThreadPort {
  runStreamed(input: string, options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}

export interface CodexClientPort {
  startThread(options: ThreadOptions): CodexThreadPort;
  resumeThread(id: string, options: ThreadOptions): CodexThreadPort;
}

export interface CodexSdkFactory {
  create(input: {
    codexPathOverride: string;
    env: Record<string, string>;
    codexConfigLockRealpath: string;
  }): CodexClientPort;
}

export async function loadCodexSdkFactory(): Promise<CodexSdkFactory> {
  const { Codex } = await import("@openai/codex-sdk");
  return {
    create: (input) => new Codex({
      codexPathOverride: input.codexPathOverride,
      env: input.env,
      config: {
        debug: {
          config_lockfile: {
            load_path: input.codexConfigLockRealpath,
            allow_codex_version_mismatch: false,
          },
        },
      },
    }) as CodexClientPort,
  };
}
