// Figure: the nightly pipeline. Inline SVG so it themes with the page (currentColor + CSS variables).
const steps = [
  { title: 'Collect', sub: 'GitHub REST, read-only' },
  { title: 'Claim backlog', sub: 'leftovers carry over' },
  { title: 'Embed', sub: 'nomic-embed-text' },
  { title: 'Triage', sub: 'Gemma 3 4B via Mastra' },
  { title: 'Digest', sub: 'markdown + review page' },
];

export function PipelineFigure() {
  const w = 150;
  const gap = 28;
  const total = steps.length * w + (steps.length - 1) * gap;
  return (
    <figure className="figure">
      <svg className="diagram" viewBox={`0 0 ${total + 40} 210`} role="img" aria-labelledby="pipe-title pipe-desc">
        <title id="pipe-title">Nightly pipeline</title>
        <desc id="pipe-desc">
          Collect, claim backlog, embed, triage and digest run as Temporal activities. Results go to Postgres; a human approves before anything is posted.
        </desc>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
          </marker>
        </defs>
        <rect x="12" y="10" width={total + 16} height="96" rx="10" fill="none" stroke="var(--rule-strong)" strokeDasharray="4 4" />
        <text x="24" y="28" fontFamily="var(--sans)" fontSize="11" fill="var(--muted)" letterSpacing="1">
          TEMPORAL WORKFLOW · RETRIES, HEARTBEATS, RESUMES AFTER SLEEP
        </text>
        {steps.map((s, i) => {
          const x = 20 + i * (w + gap);
          return (
            <g key={s.title}>
              <rect x={x} y="40" width={w} height="56" rx="8" fill="var(--sheet)" stroke="var(--rule-strong)" />
              <text x={x + w / 2} y="64" textAnchor="middle" fontFamily="var(--sans)" fontSize="14" fontWeight="600" fill="var(--ink)">
                {s.title}
              </text>
              <text x={x + w / 2} y="83" textAnchor="middle" fontFamily="var(--sans)" fontSize="11.5" fill="var(--muted)">
                {s.sub}
              </text>
              {i < steps.length - 1 && (
                <line x1={x + w + 3} y1="68" x2={x + w + gap - 3} y2="68" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arrow)" />
              )}
            </g>
          );
        })}
        <rect x="20" y="140" width={2 * w + gap} height="52" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" />
        <text x={20 + (2 * w + gap) / 2} y="162" textAnchor="middle" fontFamily="var(--sans)" fontSize="14" fontWeight="600" fill="var(--ink)">
          Tiger Data Postgres
        </text>
        <text x={20 + (2 * w + gap) / 2} y="180" textAnchor="middle" fontFamily="var(--sans)" fontSize="11.5" fill="var(--muted)">
          pgvector + full-text hybrid search
        </text>
        <line x1={20 + w} y1="98" x2={20 + w} y2="138" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arrow)" />
        <rect x={20 + 3 * (w + gap)} y="140" width={2 * w + gap} height="52" rx="8" fill="var(--human-soft)" stroke="var(--human)" />
        <text x={20 + 3 * (w + gap) + (2 * w + gap) / 2} y="162" textAnchor="middle" fontFamily="var(--sans)" fontSize="14" fontWeight="600" fill="var(--ink)">
          Maintainer approves
        </text>
        <text x={20 + 3 * (w + gap) + (2 * w + gap) / 2} y="180" textAnchor="middle" fontFamily="var(--sans)" fontSize="11.5" fill="var(--muted)">
          then, and only then, Post
        </text>
        <line x1={20 + 4 * (w + gap) + w / 2} y1="98" x2={20 + 4 * (w + gap) + w / 2} y2="138" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arrow)" />
      </svg>
      <figcaption>
        The nightly pipeline. Each step is a Temporal activity with its own retry policy; triage runs in resumable chunks of ten. Nothing on
        this path writes to GitHub: the only write is the Post button, behind the approval gate.
      </figcaption>
    </figure>
  );
}
