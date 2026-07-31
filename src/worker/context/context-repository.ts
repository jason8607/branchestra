import type { ContextBundle } from "../../shared/contracts/provider";
import type { ProviderRepository } from "../storage/provider-repository";

export class ContextRepository {
  constructor(private readonly providers: ProviderRepository, private readonly now: () => string) {}
  save(bundle: ContextBundle, runId: string): ContextBundle { return this.providers.saveContext(bundle, runId, this.now()); }
  getByHash(runId: string, hash: string): ContextBundle | undefined { return this.providers.getContextByHash(runId, hash); }
}
