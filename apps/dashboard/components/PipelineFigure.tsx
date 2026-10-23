// Figure: the nightly pipeline, drawn in the Excalidraw style: rough.js strokes (the library Excalidraw draws with)
// and the Virgil hand-drawn font. Rendered on the server with fixed seeds, so it is identical on every load.
// Colours are CSS variables, so the sketch follows the light/dark theme.
import rough from 'roughjs';

type Tone = 'plain' | 'blue' | 'orange' | 'green';
const gen = rough.generator();

const STROKE: Record<Tone, string> = { plain: 'var(--fig-ink)', blue: 'var(--fig-blue-ink)', orange: 'var(--fig-orange-ink)', green: 'var(--fig-green-ink)' };
const FILL: Record<Tone, string> = { plain: 'var(--fig-paper)', blue: 'var(--fig-blue)', orange: 'var(--fig-orange)', green: 'var(--fig-green)' };

const FILL_MARK = 'x'; // rough.js gives hachure strokes the `fill` option as their stroke; this marks them

function Sketch({ d, tone, seed, dashed }: { d: ReturnType<typeof gen.rectangle>; tone: Tone; kind?: 'shape' | 'line'; seed: number; dashed?: boolean }) {
  return (
    <g data-seed={seed}>
      {gen.toPaths(d).map((p, i) => (
        <path
          key={i}
          d={p.d}
          style={{
            stroke: p.stroke === FILL_MARK ? FILL[tone] : STROKE[tone],
            strokeWidth: p.strokeWidth,
            strokeDasharray: dashed ? '8 9' : undefined,
            fill: 'none',
          }}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
}

function Box({ x, y, w, h, title, sub, tone = 'plain', seed }: { x: number; y: number; w: number; h: number; title: string; sub: string; tone?: Tone; seed: number }) {
  const rect = gen.rectangle(x, y, w, h, {
    seed,
    roughness: 1.1,
    bowing: 1.2,
    strokeWidth: 1.6,
    fill: tone === 'plain' ? undefined : FILL_MARK,
    fillStyle: 'hachure',
    hachureGap: 10,
    hachureAngle: -41,
    fillWeight: 1.1,
  });
  return (
    <g>
      <Sketch d={rect} tone={tone} kind="shape" seed={seed} />
      <text x={x + w / 2} y={y + h / 2 - 3} textAnchor="middle" className="fig-title">
        {title}
      </text>
      <text x={x + w / 2} y={y + h / 2 + 17} textAnchor="middle" className="fig-sub">
        {sub}
      </text>
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, seed }: { x1: number; y1: number; x2: number; y2: number; seed: number }) {
  const opts = { seed, roughness: 0.9, bowing: 1.5, strokeWidth: 1.6 };
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 10;
  const a1 = angle + Math.PI - 0.45;
  const a2 = angle + Math.PI + 0.45;
  return (
    <g>
      <Sketch d={gen.line(x1, y1, x2, y2, opts)} tone="plain" kind="line" seed={seed} />
      <Sketch d={gen.line(x2, y2, x2 + head * Math.cos(a1), y2 + head * Math.sin(a1), { ...opts, seed: seed + 1 })} tone="plain" kind="line" seed={seed + 1} />
      <Sketch d={gen.line(x2, y2, x2 + head * Math.cos(a2), y2 + head * Math.sin(a2), { ...opts, seed: seed + 2 })} tone="plain" kind="line" seed={seed + 2} />
    </g>
  );
}

const STEPS = [
  { title: 'Collect', sub: 'GitHub, read-only' },
  { title: 'Claim backlog', sub: 'leftovers carry over' },
  { title: 'Embed', sub: 'nomic-embed-text' },
  { title: 'Triage', sub: 'Gemma 3 4B · Mastra' },
  { title: 'Digest', sub: 'report + review page' },
];

export function PipelineFigure() {
  const w = 168;
  const gap = 34;
  const top = 64;
  const h = 80;
  const total = STEPS.length * w + (STEPS.length - 1) * gap;
  const x0 = 24;
  const frame = gen.rectangle(10, 14, total + 28, 154, { seed: 3, roughness: 1.4, bowing: 2, strokeWidth: 1.2 });
  const xs = STEPS.map((_, i) => x0 + i * (w + gap));
  const lowW = 2 * w + gap;
  return (
    <figure className="figure">
      <svg className="diagram sketch" viewBox={`0 0 ${total + 48} 304`} role="img" aria-labelledby="pipe-title pipe-desc">
        <title id="pipe-title">Nightly pipeline</title>
        <desc id="pipe-desc">
          Collect, claim backlog, embed, triage and digest run as Temporal activities. Results go to Tiger Data Postgres; the maintainer approves before
          anything is posted.
        </desc>
        <Sketch d={frame} tone="plain" seed={3} dashed />
        <text x={30} y={44} className="fig-label">
          Temporal workflow: retries, heartbeats, resumes after sleep
        </text>
        {STEPS.map((s, i) => (
          <Box key={s.title} x={xs[i]!} y={top} w={w} h={h} title={s.title} sub={s.sub} tone={s.title === 'Triage' ? 'green' : 'plain'} seed={11 + i * 7} />
        ))}
        {STEPS.slice(0, -1).map((_, i) => (
          <Arrow key={i} x1={xs[i]! + w + 4} y1={top + h / 2} x2={xs[i + 1]! - 6} y2={top + h / 2} seed={60 + i * 5} />
        ))}
        <Box x={x0} y={216} w={lowW} h={72} title="Tiger Data Postgres" sub="pgvector + full-text hybrid search" tone="blue" seed={90} />
        <Box x={xs[3]!} y={216} w={lowW} h={72} title="Maintainer approves" sub="then, and only then, Post" tone="orange" seed={97} />
        <Arrow x1={xs[0]! + w / 2} y1={top + h + 6} x2={xs[0]! + w / 2} y2={210} seed={110} />
        <Arrow x1={xs[4]! + w / 2} y1={top + h + 6} x2={xs[4]! + w / 2} y2={210} seed={120} />
      </svg>
      <figcaption>
        The nightly pipeline. Each step is a Temporal activity with its own retry policy; triage runs in resumable chunks of ten. Nothing on this path writes
        to GitHub: the only write is the Post button, behind the approval gate.
      </figcaption>
    </figure>
  );
}
