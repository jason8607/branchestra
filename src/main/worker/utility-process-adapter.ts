import { utilityProcess } from "electron";

export interface UtilityProcessChild {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
  onExit(listener: (code: number) => void): () => void;
  kill(): boolean;
}

export interface UtilityProcessAdapter {
  fork(modulePath: string, options: { env: Record<string, string> }): UtilityProcessChild;
}

export const electronUtilityProcessAdapter: UtilityProcessAdapter = {
  fork(modulePath, options) {
    const child = utilityProcess.fork(modulePath, [], { env: options.env });
    return {
      postMessage(value) {
        child.postMessage(value);
      },
      onMessage(listener) {
        child.on("message", listener);
        return () => child.off("message", listener);
      },
      onExit(listener) {
        child.on("exit", listener);
        return () => child.off("exit", listener);
      },
      kill() {
        return child.kill();
      }
    };
  }
};
