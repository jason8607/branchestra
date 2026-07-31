import type { ProviderEvent } from "../../shared/contracts/provider";
import type { ProviderRunnerMessage } from "../../shared/contracts/provider-runner";

interface CoordinatorRepository {
  appendRawEvent(input: { id: string; runId: string; providerSeq: number; payload: unknown; receivedAt: string }): Promise<boolean> | boolean;
  saveSession(event: Extract<ProviderEvent, { type: "session.started" }>): Promise<void> | void;
}

export class ProviderRunCoordinator {
  constructor(private readonly deps: {
    repository: CoordinatorRepository;
    normalizer(raw: unknown, run: { runId: string; providerSeq: number; occurredAt: string }): ProviderEvent[];
    publish(event: ProviderEvent): Promise<void> | void;
    toolBridge: { handle(call: { callId: string; runId: string; request: unknown }): Promise<{ content: string; truncated: boolean }> };
    transport?: { send(command: unknown): Promise<void> | void };
    handleTerminalMessage?(message: Exclude<ProviderRunnerMessage, { type: "provider.raw" | "tool.call" | "runner.ready" }>): Promise<void> | void;
    ids?: { next(): string };
  }) {}

  async acceptRunnerMessage(message: ProviderRunnerMessage): Promise<void> {
    if (message.type === "provider.raw") {
      const inserted = await this.deps.repository.appendRawEvent({
        id: this.deps.ids?.next() ?? `${message.runId}:${message.providerSeq}`,
        runId: message.runId, providerSeq: message.providerSeq, payload: message.payload, receivedAt: message.receivedAt,
      });
      if (inserted === false) return;
      const events = this.deps.normalizer(message.payload, { runId: message.runId, providerSeq: message.providerSeq, occurredAt: message.receivedAt });
      for (const event of events) {
        if (event.type === "session.started") await this.deps.repository.saveSession(event);
        await this.deps.publish(event);
      }
      return;
    }
    if (message.type === "tool.call") {
      if (!this.deps.transport) throw new Error("Provider runner transport is unavailable");
      const result = await this.deps.toolBridge.handle({ runId: message.runId, callId: message.callId, request: message.request });
      await this.deps.transport.send({ type: "tool.result", runId: message.runId, callId: message.callId, result });
      return;
    }
    if (message.type !== "runner.ready") await this.deps.handleTerminalMessage?.(message);
  }
}
