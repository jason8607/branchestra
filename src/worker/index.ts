import { startWorker, type WorkerPort } from "./runtime";
import { parseWorkerEnvironment } from "./entry-environment";

const environment = parseWorkerEnvironment(process.env);
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
  dbPath: environment.dbPath,
  port,
  identity: {
    ownerInstanceId: environment.ownerInstanceId,
    workerGeneration: environment.workerGeneration,
    pid: process.pid,
    startIdentity: environment.startIdentity
  },
  leaseTtlMs: 5_000,
  heartbeatIntervalMs: 1_000
});
