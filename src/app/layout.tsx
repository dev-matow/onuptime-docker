import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";

import "./globals.css";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
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
        geistSans.variable,
        jetbrainsMono.variable,
      )}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {children}
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
