import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Literata } from 'next/font/google';
import './globals.css';

// Literata: commissioned by Google for sustained on-screen reading, with an optical-size axis that adapts the
// letterforms from 17px body text to large headings.
const serif = Literata({ subsets: ['latin'], variable: '--font-serif', display: 'swap', axes: ['opsz'] });
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Nightshift: a case study',
  description: "The maintainer's night shift: a local Gemma agent that triages PRs and issues, drafts replies, and never acts without approval.",
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
