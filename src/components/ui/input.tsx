import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input bg-card file:text-foreground placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-ring/15 disabled:bg-input/40 aria-invalid:border-destructive aria-invalid:ring-destructive/15 dark:bg-input/20 dark:disabled:bg-input/60 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/30 h-10 w-full min-w-0 rounded-lg border px-3 py-2 text-sm shadow-xs transition-[border-color,box-shadow,background-color] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
