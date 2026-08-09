"use client";

import { useEffect, useState } from "react";

import {
  BLINK,
  MARK_FRAMES,
  MARK_HEIGHT,
  MARK_VIEWBOX,
  MARK_WIDTH,
  type MarkFrame,
} from "@/lib/brand-mark";
import { cn } from "@/lib/utils";

const FRAMES = Object.keys(MARK_FRAMES) as MarkFrame[];

/**
 * The mark, blinking.
 *
 * Rarely, and by swapping whole frames: open, half, closed, half, open,
 * 180ms end to end, once every 7 to 15 seconds and twice in a row a
 * quarter of the time. Nothing here interpolates, scales, fades or moves
 * a subpixel, which is the only way an animated logo stays a logo.
 *
 * The three frames are all rendered and hidden with `display`, so the
 * swap is a paint and not a layout, and the server always renders the
 * open frame: the first client render matches it exactly, so there is
 * nothing to reconcile and the blink starts only once the effect runs.
 * Where JavaScript never runs, which includes the static demo export,
 * this degrades to {@link VigilMark}.
 */
export function BlinkingVigilMark({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  const frame = useBlink();
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={MARK_WIDTH}
      height={MARK_HEIGHT}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
      data-mark={frame}
      data-blink
      className={cn("h-[22px] w-auto", className)}
      {...props}
    >
      {FRAMES.map((f) => (
        <g key={f} data-frame={f} display={f === frame ? undefined : "none"}>
          <path d={MARK_FRAMES[f]} />
        </g>
      ))}
    </svg>
  );
}

function useBlink(): MarkFrame {
  const [frame, setFrame] = useState<MarkFrame>("open");

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: ReturnType<typeof setTimeout> | undefined;

    function at(ms: number, fn: () => void) {
      timer = setTimeout(fn, ms);
    }

    function schedule() {
      const wait =
        BLINK.minWait + Math.random() * (BLINK.maxWait - BLINK.minWait);
      at(wait, () => blink(Math.random() < BLINK.doubleChance));
    }

    function blink(again: boolean) {
      setFrame("half");
      at(BLINK.half, () => {
        setFrame("closed");
        at(BLINK.closed, () => {
          setFrame("half");
          at(BLINK.reopen, () => {
            setFrame("open");
            if (again) at(BLINK.doubleGap, () => blink(false));
            else schedule();
          });
        });
      });
    }

    // Restarting is also how this stops. A hidden tab and a reduced-motion
    // preference both leave the eye open with no timer pending, so a
    // backgrounded page is not queueing blinks nobody will see, and the
    // preference is honoured when it changes rather than only at mount.
    function restart() {
      clearTimeout(timer);
      timer = undefined;
      setFrame("open");
      if (motion.matches || document.hidden) return;
      schedule();
    }

    document.addEventListener("visibilitychange", restart);
    motion.addEventListener("change", restart);
    restart();

    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", restart);
      motion.removeEventListener("change", restart);
    };
  }, []);

  return frame;
}
