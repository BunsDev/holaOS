/**
 * A document's first page, as a picture.
 *
 * Shared documents reach a reader as a name, a size and a file-type icon —
 * nothing to judge "is this worth opening" by. The sharer's machine is the one
 * place that already holds both the bytes and the parsers, so the cover is
 * rendered here at share time and travels as an ordinary image.
 *
 * Everything becomes HTML first and is captured from one hidden window, so each
 * new type is a converter rather than a new rendering path. PDF and HTML skip
 * the conversion — Chromium renders those itself.
 */

import { BrowserWindow, session } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/** 16:9 at a width that keeps body text legible before it is scaled down. */
const CAPTURE_WIDTH = 1000;
const CAPTURE_HEIGHT = 562;
/** What the cover is stored at — a card renders it well under half this. */
const COVER_WIDTH = 1000;
/** Web fonts, images and the PDF viewer all settle after `did-finish-load`. */
const SETTLE_MS = 450;
const LOAD_TIMEOUT_MS = 15_000;
/** Its own session so the request filter below can't affect anything else. */
const COVER_PARTITION = "document-cover";
let coverSessionReady = false;

/** A shared document is somebody else's content and we run its scripts — the
 *  PDF viewer is itself JavaScript, and an HTML artifact draws with it. Local
 *  reads only, so a document that wants to phone home can't. */
function coverSession() {
  const partitionSession = session.fromPartition(COVER_PARTITION);
  if (!coverSessionReady) {
    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        details.url.startsWith("file://") ||
        details.url.startsWith("data:") ||
        details.url.startsWith("blob:") ||
        details.url.startsWith("chrome-extension://");
      callback({ cancel: !allowed });
    });
    coverSessionReady = true;
  }
  return partitionSession;
}

export type DocumentCoverKind = "html" | "pdf" | "docx" | "sheet";

export function coverKindForExtension(ext: string): DocumentCoverKind | null {
  switch (ext.toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "docx";
    case ".xls":
    case ".xlsx":
    case ".csv":
      return "sheet";
    default:
      return null;
  }
}

/** The page a converted document is poured into. Deliberately plain: a cover
 *  that invents styling misrepresents the file it stands for. */
function coverPage(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#fff}
.sheet{width:${CAPTURE_WIDTH}px;padding:56px 64px;box-sizing:border-box;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Arial,sans-serif;
  color:#1a1a1a;-webkit-font-smoothing:antialiased}
.sheet h1{font-size:27px;line-height:1.25;margin:0 0 12px}
.sheet h2{font-size:20px;margin:22px 0 8px}
.sheet h3{font-size:16px;margin:16px 0 6px}
.sheet p{margin:0 0 10px}
.sheet ul,.sheet ol{margin:0 0 10px 22px}
.sheet img{max-width:100%}
/* Documents that carry ASCII diagrams lose their shape without this — the
   converters emit the lines as ordinary paragraphs. */
.sheet pre,.sheet code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.sheet table{border-collapse:collapse;width:100%;font-size:13px}
.sheet td,.sheet th{border:1px solid #dcdcdc;padding:7px 10px;text-align:left;vertical-align:top}
.sheet tr:first-child th,.sheet thead th{background:#f3f4f6;font-weight:600}
</style></head><body><div class="sheet">${body}</div></body></html>`;
}

async function captureUrl(url: string): Promise<Buffer | null> {
  coverSession();
  const win = new BrowserWindow({
    show: false,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: COVER_PARTITION,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cover_load_timeout")), LOAD_TIMEOUT_MS),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) {
      return null;
    }
    return await sharp(image.toPNG())
      .resize({ width: COVER_WIDTH, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return null;
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

/** Render a cover, or null when the type has none and when anything at all goes
 *  wrong — a document without a cover is the state we are already in. */
export async function renderDocumentCover(
  absolutePath: string,
  toHtml: (buffer: Buffer) => Promise<string>,
): Promise<Buffer | null> {
  const kind = coverKindForExtension(path.extname(absolutePath));
  if (!kind) {
    return null;
  }
  if (kind === "html" || kind === "pdf") {
    return await captureUrl(`file://${absolutePath}`);
  }
  let tempDir = "";
  try {
    const buffer = await fs.readFile(absolutePath);
    const body = await toHtml(buffer);
    if (!body.trim()) {
      return null;
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-cover-"));
    const pagePath = path.join(tempDir, "cover.html");
    await fs.writeFile(pagePath, coverPage(body), "utf-8");
    return await captureUrl(`file://${pagePath}`);
  } catch {
    return null;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
