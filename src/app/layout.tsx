import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";

import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

/**
 * Product copy uses the system stack declared in globals.css. It prefers
 * Inter where available, then explicitly falls back through Thai-capable
 * UI faces before the platform sans. Machine output keeps the bundled
 * mono face so identifiers, durations and log values remain stable.
 */
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
    { media: "(prefers-color-scheme: light)", color: "#f8f9fc" },
    { media: "(prefers-color-scheme: dark)", color: "#101014" },
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
