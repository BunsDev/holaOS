import fs from "node:fs/promises";
import path from "node:path";

/**
 * Durable read/write for the small JSON state files in userData — browser
 * profiles, fingerprint templates, file bookmarks, the model-catalogue cache.
 *
 * Both halves matter together. The write is atomic so a crash mid-write cannot
 * leave a truncated file; the read quarantines a file that does not parse
 * instead of silently discarding it. Every caller follows a failed read with a
 * write of the fallback, so without the quarantine a single bad parse
 * permanently destroyed the only copy of the user's data.
 */

/**
 * Read JSON, falling back when the file is missing or damaged.
 *
 * A missing file is the normal first-run case and is silent. A file that
 * exists but does not parse is damaged user data: it is renamed to
 * `<name>.corrupt-<timestamp>` before the fallback is returned, so the loss is
 * recoverable and leaves evidence.
 */
export async function readJsonStateFile<T>(
  filePath: string,
  fallback: T,
  options: { log?: (message: string) => void } = {},
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return fallback; // absent (or unreadable) — nothing to preserve
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(filePath, quarantinePath).catch(() => undefined);
    options.log?.(
      `[state] ${path.basename(filePath)} did not parse (${
        error instanceof Error ? error.message : String(error)
      }); preserved at ${path.basename(quarantinePath)}`,
    );
    return fallback;
  }
}

/**
 * Write JSON atomically (temp file + rename), matching the shape already used
 * by writeRuntimeConfigTextAtomically in main.ts.
 *
 * These files are rewritten on every mutation — each browser-profile create,
 * rename, delete, default-pin, fingerprint seed and debug-port assignment — so
 * the truncation window of a plain writeFile is hit far more often than it
 * looks.
 */
export async function writeJsonStateFileAtomically(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
  try {
    await fs.rename(tempPath, filePath);
  } catch {
    // Windows cannot rename onto an existing file.
    await fs.rm(filePath, { force: true }).catch(() => undefined);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
