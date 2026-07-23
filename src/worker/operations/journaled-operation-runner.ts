import type { OperationIntentRecord, OperationJournal } from "./operation-journal";

export type OperationObservation<O, R> =
  | { outcome: "applied"; actual: O; result: R }
  | { outcome: "not_applied"; actual: O }
  | { outcome: "conflict"; actual: O }
  | { outcome: "uncertain"; actual: O };

export interface JournaledOperationSpec<E, O, R> {
  intent: OperationIntentRecord<E>;
  execute(): Promise<void>;
  observe(): Promise<OperationObservation<O, R>>;
}

export class JournaledOperationRunner {
  constructor(private readonly journal: Pick<OperationJournal,
    "recordIntent" | "markExecuting" | "recordObservation" | "complete" | "needsAttention">) {}

  async run<E, O extends Record<string, unknown>, R>(spec: JournaledOperationSpec<E, O, R>): Promise<R> {
    const intentResult = this.journal.recordIntent(spec.intent);
    const durable = intentResult.record;
    if (!intentResult.created && durable.status === "completed" && durable.observation) {
      const prior = durable.observation as { outcome: string; result?: R };
      if (prior.outcome === "applied" && "result" in prior) return prior.result as R;
    }
    if (!intentResult.created) throw new Error(`OPERATION_REQUIRES_RECONCILIATION:${durable.id}`);

    this.journal.markExecuting(durable.id);
    await spec.execute();
    let observed: OperationObservation<O, R>;
    try {
      observed = await spec.observe();
    } catch (error) {
      const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      this.journal.needsAttention(durable.id, {
        outcome: "uncertain",
        actual: { error: message }
      });
      throw error;
    }
    this.journal.recordObservation(durable.id, observed);
    if (observed.outcome === "applied") {
      this.journal.complete(durable.id);
      return observed.result;
    }

    this.journal.needsAttention(durable.id, observed);
    throw new Error(`OPERATION_${observed.outcome.toUpperCase()}:${durable.id}`);
  }
}
