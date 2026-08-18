import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

/**
 * One design space, two instances of one binary.
 *
 * Recursive carries a MONO axis, so the proportional face and the
 * monospaced face are the same drawing at two settings, and their digit
 * cell is 600/1000 em at every weight and at both ends of that axis. A
 * latency in a table cell, the same latency in a log line and the same
 * latency in a row the cursor has just bolded all occupy identical width.
 * That is why `tnum` is set nowhere in this codebase: it would be a no-op.
 *
 * Local rather than `next/font/google`, for two reasons that are not
 * preferences. Google's build ships the `rvrn` feature intact, and at
 * MONO=0 that feature swaps in an unslashed zero and a tailless `l` —
 * exactly the wrong trade for a product whose columns carry hostnames.
 * And a Google import returns one family, so the monospaced cut would have
 * to be reached through `font-variation-settings`, which the CSS `font:`
 * shorthand silently resets.
 *
 * Built by `scripts/build-fonts.py`. Recursive v1.085, Arrow Type,
 * OFL 1.1 with no Reserved Font Name.
 */
const sans = localFont({
  src: "./fonts/vigil-sans.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--font-sans",
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
});

const mono = localFont({
  src: "./fonts/vigil-mono.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--font-mono",
  // ui-monospace is already a 0.6 em cell, so the metric override that
  // would smooth a proportional fallback only introduces a shift here.
  adjustFontFallback: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

const description =
  "Monitor your services, manage incidents and keep customers informed with public status pages.";

export const metadata: Metadata = {
  metadataBase: new URL(env.APP_URL),
  title: {
    default: "Vigil, uptime monitoring & incident management",
    template: "%s",
  },
  description,
  openGraph: {
    siteName: "Vigil",
    type: "website",
    title: "Vigil, uptime monitoring & incident management",
    description,
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vigil, uptime monitoring & incident management",
    description,
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  // The browser chrome matches whichever ground the page is standing on:
  // porcelain by day, graphite by night.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f3" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // next-themes mutates the class before hydration; expected mismatch.
      suppressHydrationWarning
      className={cn(
        "h-full font-sans antialiased",
        sans.variable,
        mono.variable,
      )}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
