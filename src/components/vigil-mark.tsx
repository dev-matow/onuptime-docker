import { MARK_PATH, MARK_VIEWBOX } from "@/lib/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The Vigil mark: two curved blades around a narrow waist, one path in
 * `currentColor`.
 *
 * Drawn, not photographed. A single vector path is what lets the same
 * file be white on the application's dark surfaces and graphite on a
 * printed report without a second asset existing to fall out of date.
 *
 * The mark is still. Its predecessor, the pixel eye, blinked; the blink
 * retired with it, because animating a form this quiet would be
 * decoration rather than behaviour.
 */
export function VigilMark({
  className,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox={MARK_VIEWBOX}
      fill="currentColor"
      aria-hidden
      className={cn("h-[22px] w-auto", className)}
      {...props}
    >
      <path d={MARK_PATH} />
    </svg>
  );
}
