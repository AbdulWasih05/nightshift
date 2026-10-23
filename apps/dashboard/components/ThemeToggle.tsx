'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Mode = 'system' | 'light' | 'dark';
const ORDER: Mode[] = ['system', 'light', 'dark'];
const LABEL: Record<Mode, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

/** Cycles System → Light → Dark. Saved per browser; "system" removes the attribute and follows the OS. */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('ns-theme');
      if (saved === 'light' || saved === 'dark') setMode(saved);
    } catch {
      // storage blocked: stay on system
    }
  }, []);

  const apply = (next: Mode) => {
    setMode(next);
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('ns-theme');
      else localStorage.setItem('ns-theme', next);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  };

  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={() => apply(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!)}
      aria-label={`${LABEL[mode]}. Click to change.`}
      title={LABEL[mode]}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
