"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes injects a blocking inline script that applies the stored
 * theme class before first paint — no flash of the wrong theme. Vigil
 * presents dark-first: new visitors get the dark theme, and an explicit
 * Light/Dark/System choice persists in localStorage.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
