import { brand } from "@agents/brand";
import { Archivo, Bricolage_Grotesque } from "next/font/google";
import type { ReactNode } from "react";
import { PaperBanner, UnitsProvider } from "../lib/units";
import { Nav } from "./nav";
import "./globals.css";
import "./town.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
// Display type: chunky and a little hand-cut, like letters scissored out of card.
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });

export const metadata = { title: { default: brand.name, template: `%s | ${brand.name}` }, description: brand.tagline };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${display.variable}`}>
      <body>
        <UnitsProvider>
          <header className="top">
            <div className="shell">
              <a href="/" className="wordmark"><span className="live-dot" aria-hidden />{brand.name}</a>
              <Nav />
              <a className="btn small" href="/create">Move an agent in</a>
            </div>
          </header>
          <PaperBanner />
          <main className="shell">{children}</main>
          <footer className="foot"><div className="shell"><p>{brand.copy.disclaimer}</p><nav aria-label="Footer"><a href="/compliance">Compliance review queue</a></nav></div></footer>
        </UnitsProvider>
      </body>
    </html>
  );
}
