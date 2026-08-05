/**
 * One-click installer for the enterprise fingerprint engine (the runtime plugin
 * model — see `fingerprint-engine-seam.ts`). Downloads or takes a local
 * `fingerprint-ee-*.zip` (self-contained: `dist/` + `node_modules/`), unpacks it
 * into `<userData>/fingerprint-ee/`, strips the macOS quarantine so the native
 * deps load, and resets the seam cache so the feature activates WITHOUT a restart.
 *
 * OSS + macOS-only (the engine is macOS today). The download SOURCE is deliberately
 * a config point: `HOLABOSS_FINGERPRINT_ENGINE_URL` (a direct .zip URL) — wire it to
 * a licensed/gated backend endpoint for real distribution. Install-from-file needs
 * no source at all.
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { resetFingerprintEngineCache } from "./fingerprint-engine-seam.js";

const execFileP = promisify(execFile);

export interface InstallProgress {
  phase: "downloading" | "extracting" | "installing" | "done" | "error";
  /** 0–100 during download when the size is known. */
  pct?: number;
  message?: string;
}

export interface InstalledEngineInfo {
  present: boolean;
  version?: string;
  dir: string;
}

/** The plugin dir the seam loads from — keep in sync with the seam's resolver. */
function engineDir(): string {
  const override = process.env.HOLABOSS_FINGERPRINT_ENGINE_PATH?.trim();
  return override || path.join(app.getPath("userData"), "fingerprint-ee");
}

/** Which release asset matches this machine, or null off macOS. */
export function engineArch(): "macos-arm64" | "macos-x64" | null {
  if (process.platform !== "darwin") {
    return null;
  }
  return process.arch === "arm64" ? "macos-arm64" : "macos-x64";
}

/** A configured direct-download URL for the engine bundle, if any. */
export function resolveEngineDownloadUrl(): string | null {
  return process.env.HOLABOSS_FINGERPRINT_ENGINE_URL?.trim() || null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function installedEngineInfo(): Promise<InstalledEngineInfo> {
  const dir = engineDir();
  try {
    if (!(await exists(path.join(dir, "dist", "index.js")))) {
      return { present: false, dir };
    }
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return {
      present: true,
      version: typeof pkg.version === "string" ? pkg.version : undefined,
      dir,
    };
  } catch {
    return { present: false, dir };
  }
}

/** Install from a local `fingerprint-ee-*.zip` on disk. */
export async function installFromZip(
  zipPath: string,
  onProgress: (p: InstallProgress) => void,
): Promise<InstalledEngineInfo> {
  const dir = engineDir();
  const parent = path.dirname(dir);
  await mkdir(parent, { recursive: true });
  // Work in the SAME filesystem as the target so the final swap is an atomic rename.
  const work = await mkdtemp(path.join(parent, ".fpe-install-"));
  try {
    onProgress({ phase: "extracting", message: "Unpacking…" });
    await execFileP("/usr/bin/unzip", ["-oq", zipPath, "-d", work]);

    // The bundle root is the dir that contains dist/index.js (our zips wrap it in a
    // `fingerprint-ee/` folder; tolerate a flat zip too).
    let src = path.join(work, "fingerprint-ee");
    if (!(await exists(path.join(src, "dist", "index.js")))) {
      src = work;
    }
    if (!(await exists(path.join(src, "dist", "index.js")))) {
      throw new Error("That zip isn't a fingerprint-ee bundle (no dist/index.js).");
    }

    onProgress({ phase: "installing", message: "Installing…" });
    // Downloaded native files (better-sqlite3.node) are quarantined → the forked
    // service refuses to load them. Clear it (best-effort).
    await execFileP("/usr/bin/xattr", ["-dr", "com.apple.quarantine", src]).catch(() => {});

    // Atomic-ish swap: drop any old copy, move the new one into place.
    await rm(dir, { recursive: true, force: true });
    await rename(src, dir);

    // Re-resolve the engine on the next load — no app restart needed.
    resetFingerprintEngineCache();
    onProgress({ phase: "done", message: "Installed." });
    return await installedEngineInfo();
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Download a bundle zip from `url`, then install it. */
export async function installFromUrl(
  url: string,
  onProgress: (p: InstallProgress) => void,
): Promise<InstalledEngineInfo> {
  const parent = path.dirname(engineDir());
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, ".fpe-dl-"));
  const zipPath = path.join(work, "engine.zip");
  try {
    onProgress({ phase: "downloading", pct: 0, message: "Downloading…" });
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status}).`);
    }
    const total = Number(res.headers.get("content-length") ?? 0);
    let got = 0;
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    body.on("data", (chunk: Buffer) => {
      got += chunk.length;
      if (total > 0) {
        onProgress({ phase: "downloading", pct: Math.min(100, Math.round((got / total) * 100)) });
      }
    });
    await pipeline(body, createWriteStream(zipPath));
    return await installFromZip(zipPath, onProgress);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
