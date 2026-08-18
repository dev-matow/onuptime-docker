"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * next-themes injects a blocking inline script that applies the stored
 * theme class before first paint — no flash of the wrong theme. Vigil
 * presents light-first: the porcelain scheme is the brand's ground, and
 * an explicit Light/Dark/System choice persists in localStorage for the
 * surfaces that offer the toggle (the public status page).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
