/**
 * Filesystem + concurrency utilities (PLAN.md MG2, addresses review #5/R2-#7).
 *
 * - `atomicWriteFile`: write to a unique temp file then rename, so readers never
 *   see a half-written file and a crash mid-write can't corrupt the target.
 * - `Mutex`: a tiny in-process async lock to serialize read-modify-write on
 *   shared state (e.g. the last-pick file) so concurrent callers can't race.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Write `contents` to `path` atomically (temp file + rename). Creates parent dirs. */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp.${randomUUID()}`);
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

/** Serializes async sections: each `run()` waits for the previous to settle. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    // Keep the chain alive regardless of success/failure of this section.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
