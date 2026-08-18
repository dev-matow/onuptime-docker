"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes injects a blocking inline script that applies the stored
 * theme class before first paint — no flash of the wrong theme. Vigil
 * follows the operating system: porcelain in daylight, the graphite
 * night scheme under a dark preference, switching live when the system
 * does. An explicit Light/Dark choice persists in localStorage for the
 * surfaces that offer the toggle (the public status page).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
