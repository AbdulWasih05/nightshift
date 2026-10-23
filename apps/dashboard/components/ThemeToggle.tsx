'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'ns-theme';

const systemTheme = (): Theme => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const savedTheme = (): Theme | null => {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
};
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Light ⇄ dark. With nothing saved the page follows the OS (and keeps following it live); the first click saves
 * the opposite of what is on screen. The switch is a circular reveal from the button (View Transitions API),
 * a short colour crossfade where that API is missing, and instant under prefers-reduced-motion.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null); // null until mounted: avoids a hydration mismatch
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setTheme(savedTheme() ?? systemTheme());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = () => {
      if (!savedTheme()) setTheme(systemTheme()); // only while the user has not chosen
    };
    mq.addEventListener('change', onSystem);
    return () => mq.removeEventListener('change', onSystem);
  }, []);

  const commit = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page
    }
    setTheme(next);
  };

  const toggle = () => {
    const next: Theme = (theme ?? systemTheme()) === 'dark' ? 'light' : 'dark';
    const root = document.documentElement;
    if (reducedMotion()) return commit(next);

    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    if (!doc.startViewTransition) {
      // Fallback: crossfade colours for a moment, then drop the transition so normal hovers stay snappy.
      root.classList.add('theme-fade');
      commit(next);
      window.setTimeout(() => root.classList.remove('theme-fade'), 300);
      return;
    }

    const r = button.current?.getBoundingClientRect();
    const x = r ? r.left + r.width / 2 : window.innerWidth - 40;
    const y = r ? r.top + r.height / 2 : 32;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const transition = doc.startViewTransition(() => commit(next));
    transition.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      );
    });
  };

  const effective = theme ?? 'dark';
  const label = effective === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button ref={button} type="button" className="icon-btn theme-toggle" onClick={toggle} aria-label={label} title={label}>
      {/* Both icons are rendered and cross-fade/rotate, so the swap itself is smooth too. */}
      <Sun size={16} strokeWidth={1.75} aria-hidden="true" className={`ti ti-sun ${effective === 'dark' ? 'on' : ''}`} />
      <Moon size={16} strokeWidth={1.75} aria-hidden="true" className={`ti ti-moon ${effective === 'light' ? 'on' : ''}`} />
    </button>
  );
}
