import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { redactValue } from "./redactor";

const MAX_BYTES = 5 * 1024 * 1024;
const RETAINED = 5;
export class RotatingLog {
  private tail = Promise.resolve();
  constructor(private readonly filePath: string) {}
  write(record: unknown): Promise<void> {
    const work = this.tail.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(redactValue(record))}\n`;
      const size = await stat(this.filePath).then((info) => info.size, () => 0);
      if (size + Buffer.byteLength(line) > MAX_BYTES) await this.rotate();
      const handle = await open(this.filePath, "a", 0o600);
      try { await handle.writeFile(line, "utf8"); } finally { await handle.close(); }
    });
    this.tail = work.catch(() => undefined);
    return work;
  }
  private async rotate(): Promise<void> {
    try { await unlink(`${this.filePath}.${RETAINED}`); } catch { /* absent */ }
    for (let index = RETAINED - 1; index >= 1; index -= 1) {
      try { await rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`); } catch { /* absent */ }
    }
    try { await rename(this.filePath, `${this.filePath}.1`); } catch { /* absent */ }
  }
}
