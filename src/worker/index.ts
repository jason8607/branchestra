import { startWorker, type WorkerPort } from "./runtime";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const dbPath = requiredEnvironment("BRANCHESTRA_DB_PATH");
const ownerInstanceId = requiredEnvironment("BRANCHESTRA_OWNER_INSTANCE_ID");
const workerGeneration = requiredEnvironment("BRANCHESTRA_WORKER_GENERATION");
const startIdentity = requiredEnvironment("BRANCHESTRA_WORKER_START_IDENTITY");
const parentPort = process.parentPort;
if (!parentPort) throw new Error("Worker utility process requires process.parentPort");

const port: WorkerPort = {
  postMessage(value) {
    parentPort.postMessage(value);
  },
  onMessage(listener) {
    const wrapped = (event: Electron.MessageEvent) => listener(event.data);
    parentPort.on("message", wrapped);
    return () => parentPort.off("message", wrapped);
  }
};

void startWorker({
  dbPath,
  port,
  identity: { ownerInstanceId, workerGeneration, pid: process.pid, startIdentity },
  leaseTtlMs: 5_000,
  heartbeatIntervalMs: 1_000
});
