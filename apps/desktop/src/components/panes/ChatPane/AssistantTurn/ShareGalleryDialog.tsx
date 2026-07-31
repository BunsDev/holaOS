import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Upload } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** A post holds this many artifacts, so the picker enforces it visibly rather
 *  than letting a checkbox quietly stop responding. */
export const SHARE_GALLERY_MAX = 4;

type Thumb = { id: string; name: string; dataUrl: string | null };

/**
 * Pick which artifacts go to HolaHub, as a gallery rather than a column of
 * checkboxes — when a turn produced eight images, choosing between them is a
 * visual decision and the filenames are no help.
 */
export function ShareGalleryDialog({
  open,
  outputs,
  workspaceId,
  sharing,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  outputs: WorkspaceOutputRecordPayload[];
  workspaceId: string | null;
  sharing: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (chosen: WorkspaceOutputRecordPayload[]) => void;
}) {
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // The gallery snapshots what it was opened on. Without this guard a caller
  // that rebuilds its outputs array each render re-triggers the load, which
  // sets state, which renders again — the dialog flickers instead of loading.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      loadedKeyRef.current = null;
      return;
    }
    const key = outputs.map((o) => o.id).join(",");
    if (loadedKeyRef.current === key) {
      return;
    }
    loadedKeyRef.current = key;
    setSelected(outputs.slice(0, SHARE_GALLERY_MAX).map((o) => o.id));
    setLoading(true);
    let cancelled = false;
    Promise.all(
      outputs.map(async (output) => {
        const filePath = output.file_path ?? "";
        const name = filePath.split(/[\\/]/).pop() ?? "Artifact";
        if (!filePath) {
          return { id: output.id, name, dataUrl: null };
        }
        try {
          const preview = await window.electronAPI.fs.readFilePreview(
            filePath,
            workspaceId
          );
          return { id: output.id, name, dataUrl: preview?.dataUrl ?? null };
        } catch {
          return { id: output.id, name, dataUrl: null };
        }
      })
    ).then((next) => {
      if (!cancelled) {
        setThumbs(next);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, outputs, workspaceId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((value) => value !== id);
      }
      if (prev.length >= SHARE_GALLERY_MAX) {
        // Swap the oldest pick rather than refuse — the click meant something.
        return [...prev.slice(1), id];
      }
      return [...prev, id];
    });
  };

  const confirm = () => {
    const byId = new Map(outputs.map((output) => [output.id, output]));
    const chosen = selected
      .map((id) => byId.get(id))
      .filter((output): output is WorkspaceOutputRecordPayload =>
        Boolean(output)
      );
    if (chosen.length > 0) {
      onConfirm(chosen);
    }
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-closed:animate-out data-open:animate-in" />
        <DialogPrimitive.Popup className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-[100] flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          <DialogPrimitive.Title className="font-semibold text-base text-foreground">
            Share to HolaHub
          </DialogPrimitive.Title>
          <p className="mt-1 text-muted-foreground text-xs">
            Pick up to {SHARE_GALLERY_MAX} of {outputs.length}. A post holds{" "}
            {SHARE_GALLERY_MAX}.
          </p>

          <div className="-mx-1 mt-4 flex-1 overflow-y-auto px-1">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {thumbs.map((thumb) => {
                  const rank = selected.indexOf(thumb.id);
                  const isSelected = rank >= 0;
                  return (
                    <button
                      className={cn(
                        "group relative aspect-square overflow-hidden rounded-xl border bg-fg-2 transition-colors",
                        isSelected
                          ? "border-primary"
                          : "border-border hover:border-foreground/25"
                      )}
                      key={thumb.id}
                      onClick={() => toggle(thumb.id)}
                      type="button"
                    >
                      {thumb.dataUrl ? (
                        <img
                          alt={thumb.name}
                          className="size-full object-cover"
                          src={thumb.dataUrl}
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
                          {thumb.name}
                        </span>
                      )}
                      <span
                        className={cn(
                          "absolute top-1.5 right-1.5 grid size-5 place-items-center rounded-full text-[11px] font-medium transition-colors",
                          isSelected
                            ? "bg-primary text-primary-foreground"
                            : "bg-background/80 text-transparent group-hover:text-muted-foreground"
                        )}
                      >
                        {isSelected ? rank + 1 : <Check className="size-3" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs">
              {selected.length} of {SHARE_GALLERY_MAX} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => onOpenChange(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={selected.length === 0 || sharing}
                onClick={confirm}
                size="sm"
                type="button"
              >
                {sharing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Upload className="size-3.5" strokeWidth={1.9} />
                )}
                Share {selected.length}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
