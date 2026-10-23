import { useId } from 'react';

// Nightshift mark: a crescent moon (the overnight run) with an approval check
// resting in its hollow (nothing ships until the maintainer signs off).
// The check is knocked out of the crescent with a mask so the gap stays
// transparent on any background. Drawn on a 24px grid for navbar use.
const CRESCENT = 'M10.52 4A8.5 8.5 0 1 0 18.42 15.58A7.25 7.25 0 0 1 10.52 4Z';
const CHECK = 'M12.5 13.25l2.5 2.5L20.5 10.25';

export function Logo({ size = 22, title = 'Nightshift' }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  const maskId = `ns-logo-cut-${id}`;
  return (
    <svg
      role="img"
      aria-label={title}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d={CHECK} fill="none" stroke="#000" strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <path d={CRESCENT} fill="currentColor" mask={`url(#${maskId})`} />
      <path
        d={CHECK}
        fill="none"
        stroke="var(--accent, currentColor)"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
