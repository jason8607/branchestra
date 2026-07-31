import type { ProviderHealthService } from "./provider-health-service";

export class ProviderExecutableSelectedHandler {
  readonly type = "provider.executableSelected" as const;
  constructor(private readonly service: ProviderHealthService) {}
  async handle(command: { payload: { provider: "claude" | "codex"; selectedPath: string } }) {
    return { data: await this.service.selectExecutable(command.payload.provider, command.payload.selectedPath), replayed: false };
  }
}

export class ProviderHealthListHandler {
  readonly type = "provider.health.list" as const;
  constructor(private readonly service: ProviderHealthService) {}
  async handle() { return { data: await this.service.list(), replayed: false }; }
}
