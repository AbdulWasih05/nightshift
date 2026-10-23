'use client';

import { useEffect, useRef, useState } from 'react';

export type TocItem = { id: string; title: string };

/**
 * Table of contents with scroll tracking. Pinned in the margin on wide screens (CSS sticky), collapsible at the
 * top on narrow ones. The active entry is the last section whose heading has passed the top band of the
 * viewport, which matches where the reader's eyes are, not merely what is visible.
 */
export function Toc({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const sections = items.map((i) => document.getElementById(i.id)).filter((el): el is HTMLElement => Boolean(el));
    if (!sections.length) return;
    const update = () => {
      const band = window.innerHeight * 0.3; // a heading counts as "being read" once it is in the top 30%
      let current = sections[0]!.id;
      for (const s of sections) if (s.getBoundingClientRect().top - band <= 0) current = s.id;
      // At the very bottom, the last section is active even if its heading never reached the band.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections.at(-1)!.id;
      setActive(current);
    };
    update();
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [items]);

  // Keep the active entry visible inside a long, scrollable TOC.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const links = (ref?: React.Ref<HTMLOListElement>) => (
    <ol ref={ref}>
      {items.map((item, i) => (
        <li key={item.id}>
          <a href={`#${item.id}`} aria-current={active === item.id ? 'location' : undefined}>
            <span className="toc-num">{i + 1}</span>
            {item.title}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <aside className="toc" aria-label="Contents">
        <p className="toc-title">Contents</p>
        {links(listRef)}
      </aside>
      <details className="toc-mobile">
        <summary>Contents</summary>
        {links()}
      </details>
    </>
  );
}
