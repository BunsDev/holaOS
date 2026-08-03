import { useEffect, useRef } from "react";

/**
 * A `<video>` that stops itself when it leaves the tree.
 *
 * Removing a `<video>` from the DOM does NOT stop playback — a detached
 * HTMLMediaElement keeps playing (audio included) until it's garbage-collected.
 * So unmounting a video preview (e.g. navigating to Discover, which unmounts the
 * preview pane) leaves the sound playing in the background. Explicitly pause and
 * release the source on cleanup so leaving the preview silences it immediately.
 */
export function PreviewVideo({
  src,
  className,
}: {
  src: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) {
        return;
      }
      el.pause();
      el.removeAttribute("src");
      el.load();
    };
  }, []);
  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={ref}
        src={src}
        controls
        autoPlay
        loop
        className={className}
      />
    </>
  );
}
