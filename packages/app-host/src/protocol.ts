// Holaboss desktop host bridge — shared protocol.
//
// Imported by BOTH sides so they can never drift:
//   - the web client (@holaboss/app-host, this package's main entry)
//   - the desktop app-surface preload + main process (apps/desktop, via a
//     workspace:* dep)
//
// Pure types + constants. No runtime dependencies. See
// docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.

/** Bridge protocol version. Additive ops that a page must feature-detect bump
 *  this so `window.__holabossHost.version` gates them; a hosted page checks
 *  `version >= N`. v2 adds `item.open`; v3 adds `holahub.consume-pending-share`;
 *  v4 adds `colorScheme` / `onColorSchemeChange`. */
export const BRIDGE_VERSION = 4 as const;

/** The global the app-surface preload injects into the hosted HolaApp page. */
export const HOST_GLOBAL_KEY = "__holabossHost" as const;

/** IPC channels between the app-surface preload and the desktop main process. */
export const HOST_IPC = {
  capabilities: "appSurface:host:capabilities",
  invoke: "appSurface:host:invoke",
  /** Synchronous, so the preload has the scheme before the page's first inline
   *  script runs — a hosted page that paints one frame in the wrong theme
   *  flashes white on every open. */
  colorScheme: "appSurface:host:color-scheme",
} as const;

/** The desktop's effective light/dark scheme, mirrored into hosted pages so a
 *  surface reads as part of the app instead of a differently-themed website. */
export type HostColorScheme = "light" | "dark";

/** Event main → app-surface preload: the desktop color scheme changed. */
export const HOST_COLOR_SCHEME_CHANGED =
  "appSurface:host:color-scheme-changed" as const;

/** Event main → shell renderer: "open this chat with this input". */
export const HOST_RENDERER_EVENT = "host:openChat" as const;

/** Event main → shell renderer: "install this item" (carries a requestId).
 *  Fired when a hosted page (e.g. HolaHub) invokes the `install` op. The shell
 *  installs it HEADLESSLY (in place — no navigation) for keyless items, or opens
 *  the native connect surface for keyed/gated ones, then replies via
 *  HOST_INSTALL_RESULT so the invoking page can reflect the outcome. */
export const HOST_INSTALL_EVENT = "host:openInstall" as const;

/** Event shell renderer → main: the install ran; here's its outcome. Correlated
 *  back to the pending `install` invoke by requestId. */
export const HOST_INSTALL_RESULT = "host:installResult" as const;

/** Event main → shell renderer: "report what's installed" (carries a requestId).
 *  Fired when a hosted page invokes `install.status`; the shell replies via
 *  HOST_INSTALL_STATUS_RESULT with the installed items so the page can reflect an
 *  "Installed" state instead of always offering "Install". */
export const HOST_INSTALL_STATUS_EVENT = "host:installStatus" as const;

/** Event shell renderer → main: the installed-items list (correlated by requestId). */
export const HOST_INSTALL_STATUS_RESULT = "host:installStatusResult" as const;

/** Event main → shell renderer: "open this already-installed item". Fired when a
 *  hosted page (HolaHub) invokes `item.open` for a holaapp — the shell opens that
 *  app's surface. (skill/mcp/capability open a General chat instead, handled in
 *  main via the chat flow, so they don't use this event.) */
export const HOST_OPEN_APP_EVENT = "host:openApp" as const;

/** Event main → shell renderer: "the HolaEmployee roster changed — refetch it".
 *  Fired when a hosted page (the `/employees` surface) invokes `employees.changed`
 *  after creating / renaming / archiving an employee. Fire-and-forget: the shell
 *  invalidates its roster query so the sidebar reflects the change immediately,
 *  without the surface's gateway writes ever having to reach the desktop bridge. */
export const HOST_EMPLOYEES_CHANGED_EVENT = "host:employeesChanged" as const;

/** Op names. ADDITIVE only — never rename/remove an op once shipped. */
export const HOST_OPS = {
  chatStart: "chat.start",
  install: "install",
  installStatus: "install.status",
  itemOpen: "item.open",
  holahubConsumePendingShare: "holahub.consume-pending-share",
  employeesChanged: "employees.changed",
} as const;
export type HostOp = (typeof HOST_OPS)[keyof typeof HOST_OPS];

/** Result envelope every host op returns. */
export type HostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

/** A generic, cross-app context object — the unit attached to the composer.
 *  Carries an inline snapshot (immediate grounding) AND refs + an MCP hint
 *  (so the agent can pull the live/full version via the app's MCP). */
export interface AppContext {
  /** hola_app_id, e.g. "need-review". */
  app: string;
  /** app-defined kind, e.g. "record" | "artifact" | "url". */
  kind: string;
  title: string;
  /** stable references the agent / app MCP can resolve, e.g. { recordId }. */
  refs?: Record<string, string>;
  /** an immediate, inline snapshot of the content. */
  snapshot?: {
    mime: "text/html" | "text/markdown" | "text/plain";
    content: string;
  };
  /** how the agent can expand it live via the app's MCP. */
  mcp?: { server: string; hint?: string };
}

// ── op: chat.start ────────────────────────────────────────────────────────

export interface ChatStartInput {
  /** Pre-filled composer text. */
  prompt?: string;
  /** Context objects attached to the composer as pills. */
  context?: AppContext[];
  /** Skills to quote in the composer as skill chips (their ids == workspace
   *  skill_id). Rendered as `/skill` chips, not generic context pills. */
  skillIds?: string[];
  /** Open the session on this model (a resolvable id, not a display name). A
   *  model the viewer does not have falls back to their default rather than
   *  failing the hand-off — a Reproduce should never be blocked by it. */
  model?: string;
  /** Generate images with this model in the handed-over session. There is no
   *  per-turn image model — the agent's image tool takes only prompt, filename
   *  and size — so this sets the workspace's image-generation setting, and the
   *  session opens in image mode where the model pill shows it. A remix that
   *  quietly used a different model would not be a remix. */
  imageModel?: string;
  /** The same, for video. Sent instead of `imageModel`, never alongside it: the
   *  two composer modes are exclusive, and a video's model in the image slot
   *  both opens the wrong mode and overwrites a setting it has no business
   *  touching. */
  videoModel?: string;
  /** Files to stage on the composer as pending attachments — a Reproduce sends
   *  the shared Output here so the viewer works "from something like this".
   *  They land as ordinary attachments, so removing one is just removing it. */
  attachments?: ChatStartAttachment[];
  /** Create a fresh session (default true). */
  newSession?: boolean;
  /** Auto-send instead of leaving an editable draft (default false). */
  autoSubmit?: boolean;
  /** Optional session title. */
  title?: string;
  /** Open a General (workspace-wide) session instead of one owned/tool-scoped by
   *  the calling HolaApp. Used by system surfaces like HolaHub whose hand-off
   *  belongs in General, not under an app row (default false → app-bounded). */
  general?: boolean;
}

/** Base64 because the bridge is IPC, not a network the renderer can reach —
 *  the same transport a ShareDraft's images already use. */
export interface ChatStartAttachment {
  fileName: string;
  contentType: string;
  dataBase64: string;
}

export interface ChatStartResult {
  sessionId: string;
}

// ── op: install ───────────────────────────────────────────────────────────

/** A catalog item a hosted page (HolaHub) asks the desktop to install. Keyless
 *  items (skills, keyless MCPs, connect-free capabilities) install headlessly in
 *  place; keyed/gated ones open the native connect surface focused on `ref`. */
export interface InstallInput {
  type: "skill" | "mcp" | "holaapp" | "capability";
  /** The catalog id/slug in the source catalog. */
  ref: string;
  /** Credentials for a keyed item, keyed by required-key name. Supplied on a
   *  retry after a first call returned `needsConnect` with its `requiredKeys`. */
  values?: Record<string, string>;
}

/** Outcome of an install request.
 *  - `installed` — attached/installed just now (in place, no navigation).
 *  - `already`   — was already installed; nothing to do.
 *  - `needsConnect` — the item needs credentials/an integration first; the
 *    native connect surface was opened (`opened`) OR `requiredKeys` lists the
 *    keys the caller may collect and resend via InstallInput.values.
 *  - `error` — install failed; see `message`. */
export type InstallStatus = "installed" | "already" | "needsConnect" | "error";

export interface InstallResult {
  status: InstallStatus;
  /** Human-facing detail (error text, or why a connect is needed). */
  message?: string;
  /** needsConnect: the desktop opened its native connect surface for the item. */
  opened?: boolean;
  /** needsConnect: the required credential keys, if the caller can collect them
   *  and retry with InstallInput.values (else the native surface was opened). */
  requiredKeys?: string[];
}

/** Payload of HOST_INSTALL_EVENT (main → shell renderer). */
export interface InstallEventPayload extends InstallInput {
  /** Correlates the eventual HOST_INSTALL_RESULT back to the pending invoke. */
  requestId: string;
  /** The app-surface id that requested the install (e.g. "holahub"). */
  sourceAppId: string;
}

/** Payload of HOST_INSTALL_RESULT (shell renderer → main). */
export interface InstallResultMessage {
  requestId: string;
  result: InstallResult;
}

// ── op: install.status ────────────────────────────────────────────────────

/** One catalog item currently installed on this desktop (type + its catalog ref). */
export interface InstalledItem {
  type: InstallInput["type"];
  ref: string;
}

/** The result of `install.status` — everything installed, so an install surface
 *  can show "Installed" for items already present. */
export interface InstalledList {
  items: InstalledItem[];
}

/** Payload of HOST_INSTALL_STATUS_EVENT (main → shell renderer). */
export interface InstallStatusEventPayload {
  /** Correlates the eventual HOST_INSTALL_STATUS_RESULT back to the pending invoke. */
  requestId: string;
}

/** Payload of HOST_INSTALL_STATUS_RESULT (shell renderer → main). */
export interface InstallStatusResultMessage {
  requestId: string;
  list: InstalledList;
}

// ── op: item.open ─────────────────────────────────────────────────────────

/** An already-installed catalog item a hosted page (HolaHub) asks the desktop to
 *  open. A holaapp opens its surface; a skill/mcp/capability opens a General chat
 *  where the installed capability is available. */
export interface OpenItemInput {
  type: InstallInput["type"];
  ref: string;
  /** Display name of the item. For a skill/mcp/capability (which opens a chat)
   *  the desktop carries it into the new chat's composer as a context card, so a
   *  human-readable title beats a bare ref. Optional for back-compat. */
  title?: string;
}

export interface OpenItemResult {
  /** True when the desktop opened the item (a surface or a chat). */
  opened: boolean;
}

/** Payload of HOST_OPEN_APP_EVENT (main → shell renderer): open this holaapp's
 *  surface. The shell resolves the full app definition from the catalog by ref. */
export interface OpenAppEventPayload {
  ref: string;
}

// ── op: holahub.consume-pending-share ─────────────────────────────────────

/** One tool the shared output was made with — a catalog ref the HolaHub composer
 *  pre-attaches as a post item. `derived` was detected from what the sharer
 *  explicitly invoked and is not theirs to remove; `attached` is a plain
 *  recommendation they can drop. */
export interface ShareDraftItem {
  type: "skill" | "mcp" | "holaapp" | "capability" | "integration";
  ref: string;
  name: string;
  origin: "derived" | "attached";
}

/** How the sharer chose to share — mirrors the ChatPane share mode. It settles
 *  which is the hero when a draft carries both a transcript and media; it is not
 *  a post taxonomy. */
export type ShareDraftForm = "conversation" | "output";

/** The inputs that made the Output: the prompt that produced it and the models
 *  behind it. Its tools travel in `items`. */
export interface ShareDraftRecipe {
  prompt: string;
  /** The session model — what Reproduce seeds the new conversation with. */
  model: string;
  /** The model that produced the artifact (image/video generation). Shown to
   *  the reader; never seeded as a session model. */
  outputModel: string;
}

/** A desktop output the shell staged for sharing. The shell (ChatPane) builds it
 *  and stages it via a trusted shell→main IPC; the HolaHub web surface pulls it
 *  once on its compose route via `holahub.consume-pending-share`, then prefills
 *  its composer. The sharer edits everything here except a `derived` item, which
 *  they may demote but not delete. */
/** How an artifact was generated, read off the output record the runtime wrote.
 *  Per-artifact, not per-post: four images in one post are four generations. */
export interface ShareDraftGeneration {
  /** The prompt actually sent to the generator — a skill compiles a detailed one
   *  from a short ask, and that compiled text is the interesting half. */
  prompt?: string;
  /** What the provider rewrote the prompt to, when it does that. A separate
   *  fact from `prompt`: one is what was asked for, the other what was used. */
  revisedPrompt?: string;
  /** Generator model id, e.g. "gpt-image-2". Not a session model. */
  model?: string;
  provider?: string;
  size?: string;
  seconds?: number;
}

export interface ShareDraftImage {
  /** base64 (no data: prefix) of the generated image file. */
  dataBase64: string;
  contentType: string;
  generation?: ShareDraftGeneration;
}

/** A generated document (pptx/docx/pdf/…) captured from a turn — base64, keeping
 *  the original file name; the composer uploads it on prefill. */
export interface ShareDraftFile {
  fileName: string;
  contentType: string;
  dataBase64: string;
  /** PNG of the document's first page. Rendered by the sharer, whose machine is
   *  the only one holding both the bytes and the parsers; absent when the type
   *  has no cover or rendering failed, which the reader sees as today's icon. */
  coverBase64?: string;
}

/** One turn of a shared conversation — text + its captured media/files. No
 *  assistant internals (thinking/trace/tool args) — dropped at capture. */
// A simplified tool/phase step the assistant ran this turn (title only — no
// args/output details), for a "Worked across N steps" trace on the shared post.
export interface ShareDraftSessionStep {
  title: string;
  kind: "phase" | "tool";
}

export interface ShareDraftSessionTurn {
  role: "user" | "assistant";
  text: string;
  createdAt?: string | null;
  images?: ShareDraftImage[];
  videos?: ShareDraftImage[];
  files?: ShareDraftFile[];
  steps?: ShareDraftSessionStep[];
  /** Friendly name of the model behind this reply (assistant turns only). */
  model?: string;
}

export interface ShareDraft {
  title: string;
  /** Markdown body. Empty by default — the share centers on the produced
   *  artifact and the user writes their own caption (optionally AI-drafted from
   *  `sourceText`). */
  body: string;
  /** The assistant turn's text — NOT shown as the body; carried as hidden
   *  context so the composer's "draft with AI" button can seed a caption. */
  sourceText: string;
  /** Already uploaded to holahub_images; the composer attaches by id. */
  imageIds: string[];
  /** Generated images captured from the turn's outputs — the composer (which
   *  holds the session) uploads them on prefill. */
  images: ShareDraftImage[];
  /** Generated video(s) captured from the turn — same base64+upload path as
   *  images (size-capped upstream to keep IPC sane). */
  videos: ShareDraftImage[];
  /** Deliverable documents (pptx/docx/xlsx/pdf/…) attached to the post itself.
   *  They used to need a fabricated one-turn session to travel at all, which
   *  made a shared deck render and act as a conversation. */
  files?: ShareDraftFile[];
  /** Session tools resolved to catalog refs, each carrying its origin. */
  items: ShareDraftItem[];
  /** Which share mode produced this draft; absent = a tool-only share. */
  form?: ShareDraftForm;
  /** The prompt + model that made the Output, for Reproduce. */
  recipe?: ShareDraftRecipe;
  /** Provenance for analytics (e.g. "desktop_chat"). */
  source: string;
  /** When present, this is a whole-conversation share → a "session" post. */
  session?: { turns: ShareDraftSessionTurn[] };
}

// ── op: employees.changed ─────────────────────────────────────────────────

/** Input for `employees.changed` — a fire-and-forget nudge from the `/employees`
 *  surface telling the desktop shell to refetch its HolaEmployee roster. `reason`
 *  is advisory (for logging only); the shell just invalidates its roster query. */
export interface EmployeesChangedInput {
  reason?: "created" | "updated" | "archived";
}

/** Input/result per op — the contract the desktop dispatch table implements. */
export interface HostOpMap {
  "chat.start": { input: ChatStartInput; result: ChatStartResult };
  install: { input: InstallInput; result: InstallResult };
  "install.status": { input: Record<string, never>; result: InstalledList };
  "item.open": { input: OpenItemInput; result: OpenItemResult };
  "holahub.consume-pending-share": {
    input: Record<string, never>;
    result: ShareDraft | null;
  };
  "employees.changed": {
    input: EmployeesChangedInput;
    result: Record<string, never>;
  };
}

/** The shape the preload exposes as `window[HOST_GLOBAL_KEY]`. */
export interface HolabossHost {
  readonly version: number;
  capabilities(): Promise<HostOp[]>;
  invoke<Op extends HostOp>(
    op: Op,
    payload: HostOpMap[Op]["input"],
  ): Promise<HostResult<HostOpMap[Op]["result"]>>;
  /** The desktop's current scheme. Absent on a host older than v4 — fall back to
   *  the page's own `prefers-color-scheme`. */
  colorScheme?(): HostColorScheme;
  /** Subscribe to desktop scheme changes (v4+). Listeners live as long as the
   *  document; the preload drops them on navigation. */
  onColorSchemeChange?(listener: (scheme: HostColorScheme) => void): void;
}
