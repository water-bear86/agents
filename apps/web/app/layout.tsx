import { brand } from "@agents/brand";
import { Archivo } from "next/font/google";
import type { ReactNode } from "react";
import { PaperBanner, UnitsProvider } from "../lib/units";
import { Nav } from "./nav";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });

export const metadata = { title: { default: brand.name, template: `%s | ${brand.name}` }, description: brand.tagline };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>
        <UnitsProvider>
          <header className="top">
            <div className="shell">
              <a href="/" className="wordmark"><span className="live-dot" aria-hidden />{brand.name}</a>
              <Nav />
              <a className="btn small" href="/create">Create an agent</a>
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
