import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import './globals.css';

// Geist Sans + Geist Mono: the Next.js docs typefaces (OFL-1.1).
const sans = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
// Virgil: Excalidraw's hand-drawn font (OFL-1.1), self-hosted, used only inside the sketch figures.
const hand = localFont({ src: './fonts/Virgil.woff2', variable: '--font-hand', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Nightshift: a case study',
  description: "The maintainer's night shift: a local Gemma agent that triages PRs and issues, drafts replies, and never acts without approval.",
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${hand.variable}`} suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (no flash). "system" (no attribute) follows the OS setting. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('ns-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
