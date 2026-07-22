import type { Database } from "./database";

export interface WorkerIdentity {
  ownerInstanceId: string;
  workerGeneration: string;
  pid: number;
  startIdentity: string;
}

export interface WorkerLeaseStore {
  acquire(identity: WorkerIdentity, nowMs: number, ttlMs: number): "acquired" | "held";
  heartbeat(identity: WorkerIdentity, nowMs: number): boolean;
  release(identity: WorkerIdentity): void;
}

export function createWorkerLeaseStore(database: Database): WorkerLeaseStore {
  return {
    acquire(identity, nowMs, ttlMs) {
      return database.transaction(() => {
        const current = database.prepare("SELECT owner_instance_id, worker_generation, pid, start_identity, heartbeat_ms FROM worker_leases WHERE lease_key = 1").get() as {
          owner_instance_id: string;
          worker_generation: string;
          pid: number;
          start_identity: string;
          heartbeat_ms: number;
        } | undefined;
        const same = current?.owner_instance_id === identity.ownerInstanceId
          && current.worker_generation === identity.workerGeneration
          && current.pid === identity.pid
          && current.start_identity === identity.startIdentity;
        if (current && current.heartbeat_ms > nowMs - ttlMs && !same) return "held";
        database.prepare("INSERT INTO worker_leases(lease_key, owner_instance_id, worker_generation, pid, start_identity, heartbeat_ms) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(lease_key) DO UPDATE SET owner_instance_id=excluded.owner_instance_id, worker_generation=excluded.worker_generation, pid=excluded.pid, start_identity=excluded.start_identity, heartbeat_ms=excluded.heartbeat_ms").run(identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity, nowMs);
        return "acquired";
      });
    },
    heartbeat(identity, nowMs) {
      const result = database.prepare("UPDATE worker_leases SET heartbeat_ms = ? WHERE lease_key = 1 AND owner_instance_id = ? AND worker_generation = ? AND pid = ? AND start_identity = ?").run(nowMs, identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity);
      return Number(result.changes) === 1;
    },
    release(identity) {
      database.prepare("DELETE FROM worker_leases WHERE lease_key = 1 AND owner_instance_id = ? AND worker_generation = ? AND pid = ? AND start_identity = ?").run(identity.ownerInstanceId, identity.workerGeneration, identity.pid, identity.startIdentity);
    }
  };
}
