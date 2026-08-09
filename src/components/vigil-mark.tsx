import {
  MARK_FRAMES,
  MARK_HEIGHT,
  MARK_VIEWBOX,
  MARK_WIDTH,
} from "@/lib/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The Vigil mark: a pixel eye on a 25 x 11 grid, open.
 *
 * Drawn, not photographed. It is one `<path>` of axis-aligned rectangles
 * in `currentColor`, which is what lets the same file be white on the
 * application's dark surfaces and black on a printed report without a
 * second asset existing to fall out of date.
 *
 * This is the frame to use anywhere motion would be noise or would not
 * survive: favicons, print, the demo export (which ships no JavaScript),
 * screenshots, and anything small enough that a blink reads as a glitch.
 * {@link BlinkingVigilMark} is the animated one, and there should be at
 * most one of those on a page.
 */
export function VigilMark({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      width={MARK_WIDTH}
      height={MARK_HEIGHT}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
      data-mark="open"
      className={cn("h-[22px] w-auto", className)}
      {...props}
    >
      <path d={MARK_FRAMES.open} />
    </svg>
  );
}
