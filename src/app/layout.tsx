import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google";

import { SiteNav } from "@/components/site-nav";
import "./globals.css";

// A serif for questions and titles, a sans for reading, a mono for data.
const sans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"] });
const serif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});
const mono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const DESCRIPTION =
  "Ask questions about public companies, answered only from their SEC 10-K filings, with a citation on every claim.";

// Absolute base for link previews. Vercel injects the production host, so the
// URL never has to be hardcoded here or kept in sync by hand after a rename.
const siteUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "FinSight",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    url: "/",
    siteName: "FinSight",
    title: "FinSight",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "FinSight",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="font-sans min-h-full flex flex-col">
        <SiteNav />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
