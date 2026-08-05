/**
 * Enable / install gate for the fingerprint Browser Profiles engine.
 *
 * Shown instead of the fingerprint editor when the engine isn't attached yet — the
 * anti-detect engine is the licensed `@holaboss/fingerprint-ee` package, loaded at
 * runtime (open-core). This dialog lets the user ATTACH it as a one-click plugin:
 *   • "Install" — downloads the bundle from the configured source (if any),
 *   • "Install from file…" — picks a downloaded `fingerprint-ee-*.zip`,
 * both of which drop it into `<userData>/fingerprint-ee/` and activate it live (no
 * restart). "Contact sales" remains for getting access/a license.
 */
import { useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Loader2, ShieldCheck, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// Where "Contact sales" sends the user. Update to the real enterprise/contact page.
const CONTACT_SALES_URL = "https://www.holaos.ai/enterprise";

const BULLETS = [
  "Unique canvas / WebGL / GPU / timezone per profile",
  "Fresh identities that pass bot detection",
  "Reusable fingerprint templates + import",
];

interface ContactSalesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the engine is successfully installed, so the pane can re-gate. */
  onInstalled?: () => void;
}

type Progress = {
  phase: "downloading" | "extracting" | "installing" | "done" | "error";
  pct?: number;
  message?: string;
};

export function ContactSalesDialog({
  open,
  onOpenChange,
  onInstalled,
}: ContactSalesDialogProps) {
  const api = window.electronAPI?.profiles;
  const [downloadAvailable, setDownloadAvailable] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !api?.engineDownloadAvailable) {
      return;
    }
    setError(null);
    void api.engineDownloadAvailable().then(setDownloadAvailable);
  }, [open, api]);

  const contactSales = () => {
    void window.electronAPI?.ui.openExternalUrl(CONTACT_SALES_URL);
    onOpenChange(false);
  };

  const runInstall = useCallback(
    async (source: "file" | "url") => {
      if (!api) {
        return;
      }
      setError(null);
      setInstalling(true);
      setProgress({ phase: "installing", message: "Starting…" });
      const unsubscribe = api.onEngineInstallProgress?.((p) => setProgress(p));
      try {
        const result =
          source === "file"
            ? await api.installEngineFromFile()
            : await api.installEngineFromUrl();
        if ("canceled" in result && result.canceled) {
          return; // user dismissed the file picker
        }
        if (result.ok) {
          onInstalled?.();
          onOpenChange(false);
          return;
        }
        setError(result.error ?? "Install failed.");
      } catch (e) {
        setError((e as Error)?.message ?? "Install failed.");
      } finally {
        unsubscribe?.();
        setInstalling(false);
        setProgress(null);
      }
    },
    [api, onInstalled, onOpenChange],
  );

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex w-[min(460px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <header className="flex items-start justify-between gap-4 border-border border-b px-6 py-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400">
                <ShieldCheck className="size-5" />
              </span>
              <div className="min-w-0">
                <DialogPrimitive.Title className="flex items-center gap-2 font-semibold text-[19px] text-foreground">
                  Fingerprint Browser
                  <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-[10px] text-violet-600 uppercase tracking-wide dark:text-violet-400">
                    Enterprise
                  </span>
                </DialogPrimitive.Title>
              </div>
            </div>
            <DialogPrimitive.Close
              render={
                <button
                  aria-label="Close"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "shrink-0 rounded-full",
                  )}
                  type="button"
                >
                  <X size={16} />
                </button>
              }
            />
          </header>

          <div className="px-6 py-5">
            <p className="text-foreground text-sm leading-relaxed">
              Give each profile a distinct, detection‑resistant browser identity —
              a real anti‑detect fingerprint for multi‑account work, with a proxy
              per profile.
            </p>
            <ul className="mt-4 space-y-2">
              {BULLETS.map((bullet) => (
                <li
                  key={bullet}
                  className="flex items-start gap-2 text-muted-foreground text-sm"
                >
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
                  {bullet}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-muted-foreground text-xs">
              Install the licensed engine to enable it here — it drops in and
              activates without a restart.
            </p>
            {error ? (
              <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex min-h-[36px] shrink-0 items-center gap-2 border-border border-t px-6 py-4">
            {installing ? (
              <div className="flex w-full items-center gap-3">
                <Loader2 className="size-4 shrink-0 animate-spin text-violet-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-foreground text-sm">
                    {progress?.message ?? "Installing…"}
                    {typeof progress?.pct === "number"
                      ? ` ${progress.pct}%`
                      : ""}
                  </p>
                  {typeof progress?.pct === "number" ? (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-fg-2">
                      <div
                        className="h-full rounded-full bg-violet-500 transition-all"
                        style={{ width: `${progress.pct}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <button
                  className={buttonVariants({ variant: "ghost" })}
                  onClick={contactSales}
                  type="button"
                >
                  Contact sales
                </button>
                <div className="flex-1" />
                <button
                  className={buttonVariants({ variant: "outline" })}
                  onClick={() => void runInstall("file")}
                  type="button"
                >
                  Install from file…
                </button>
                {downloadAvailable ? (
                  <Button onClick={() => void runInstall("url")} type="button">
                    Install
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
