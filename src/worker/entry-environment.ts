import { z } from "zod";
import { ZERO_WORKER_GENERATION } from "../shared/contracts/protocol";

export interface WorkerEntryEnvironment {
  dbPath: string;
  ownerInstanceId: string;
  workerGeneration: string;
  startIdentity: string;
  e2eMockScenario?: "two-round-success" | "interrupted-run";
}

const UuidSchema = z.string().uuid();
const ActiveGenerationSchema = UuidSchema.refine(
  (value) => value !== ZERO_WORKER_GENERATION,
  "active worker generation required"
);

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name];
  if (value === undefined) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function parseWorkerEnvironment(environment: Record<string, string | undefined>): WorkerEntryEnvironment {
  const dbPath = required(environment, "BRANCHESTRA_DB_PATH");
  if (dbPath.trim().length === 0) throw new Error("BRANCHESTRA_DB_PATH must not be blank");
  const scenario = environment.BRANCHESTRA_E2E_MOCK_SCENARIO;
  if (scenario !== undefined && scenario !== "two-round-success" && scenario !== "interrupted-run") {
    throw new Error("BRANCHESTRA_E2E_MOCK_SCENARIO is invalid");
  }
  return {
    dbPath,
    ownerInstanceId: UuidSchema.parse(required(environment, "BRANCHESTRA_OWNER_INSTANCE_ID")),
    workerGeneration: ActiveGenerationSchema.parse(required(environment, "BRANCHESTRA_WORKER_GENERATION")),
    startIdentity: UuidSchema.parse(required(environment, "BRANCHESTRA_WORKER_START_IDENTITY")),
    ...(scenario ? { e2eMockScenario: scenario } : {})
  };
}
