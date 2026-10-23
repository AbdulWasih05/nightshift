import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nightshift',
  description: "The maintainer's night shift: overnight PR and issue triage that never acts without approval.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
