declare global {
  var __branchestraE2E: { crashWorker(): void } | undefined;
}

export function installE2EControls(environment: Readonly<Record<string, string | undefined>>, supervisor: { forceCrashForTest(): void }): void {
  globalThis.__branchestraE2E = undefined;
  if (environment.BRANCHESTRA_E2E !== "1") return;
  globalThis.__branchestraE2E = { crashWorker: () => supervisor.forceCrashForTest() };
}
