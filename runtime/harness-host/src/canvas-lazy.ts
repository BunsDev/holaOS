/**
 * Lazy accessor for `@napi-rs/canvas`.
 *
 * The native binding costs **~80ms of every harness-host boot** — measured with
 * `--cpu-prof` on the built bundle, it is 80ms of a 573ms module load and the
 * single largest third-party entry in the profile. harness-host is spawned fresh
 * for every turn, so that 80ms is on the critical path of every single
 * time-to-first-token, whether or not the turn touches an image.
 *
 * Most turns never do. Canvas is needed only when a tool result or an inline
 * attachment carries an image big enough to need downscaling, so importing it
 * eagerly pays a per-turn cost for a path most runs skip entirely.
 *
 * The convention already existed — `harnesses/src/attachment-content.ts` passes
 * `() => import("@napi-rs/canvas")` — but the two harness-host callers used a
 * static import, which is enough to pull the binding into the boot path for
 * everyone. Both now go through here.
 *
 * Memoized on the PROMISE rather than the module, so several image blocks in one
 * turn share a single load (and a concurrent pair cannot start two), while a turn
 * that uses images pays the cost exactly once.
 */
type CanvasModule = typeof import("@napi-rs/canvas");

let canvasModulePromise: Promise<CanvasModule> | null = null;

export function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas");
  }
  return canvasModulePromise;
}

/** Test seam: forget the memoized load. Not used in production — the module is
 *  immutable once loaded and re-importing it would only re-pay the 80ms. */
export function resetCanvasModuleForTests(): void {
  canvasModulePromise = null;
}
