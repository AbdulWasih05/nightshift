import { auth0, isAllowed } from '@/lib/auth0';
import { publicStats, type PublicStats } from '@/lib/data';
import { PipelineFigure } from '@/components/PipelineFigure';
import { Topbar } from '@/components/Topbar';

export const dynamic = 'force-dynamic';

const SECTIONS = [
  ['problem', 'Problem'],
  ['design', 'Design'],
  ['safety', 'Safety model'],
  ['duplicates', 'Duplicate detection'],
  ['results', 'Results'],
  ['failures', 'Failures and what changed'],
  ['reproduce', 'Reproduce'],
] as const;

const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : null);

export default async function CaseStudy() {
  const session = await auth0.getSession();
  const allowed = isAllowed(session?.user);
  let stats: PublicStats | null = null;
  try {
    stats = await publicStats();
  } catch {
    stats = null; // database unreachable: the document still renders, results say so
  }
  const scheduled = stats?.nights.filter((n) => n.trigger === 'scheduled') ?? [];
  const manual = stats?.nights.filter((n) => n.trigger === 'manual') ?? [];

  return (
    <>
      <Topbar loggedIn={Boolean(session)} allowed={allowed} />
      <div className="doc">
        <aside className="toc" aria-label="Contents">
          <p className="toc-title">Contents</p>
          <ol>
            {SECTIONS.map(([id, title], i) => (
              <li key={id}>
                <a href={`#${id}`}>
                  {i + 1}. {title}
                </a>
              </li>
            ))}
          </ol>
        </aside>

        <article className="doc-main">
          <p className="kicker">Engineering case study</p>
          <h1 className="doc-title">Nightshift: the maintainer&apos;s night shift, on a laptop</h1>
          <p className="doc-subtitle">
            A local Gemma agent reads the pull request and issue pile while you are away, buckets every item, drafts the reply, and hands you
            one digest. It never posts, labels, closes or merges anything without your approval.
          </p>

          <dl className="meta">
            <div>
              <dt>Author</dt>
              <dd>
                <a href="https://github.com/AbdulWasih05">AbdulWasih05</a> · advisor: Usman
              </dd>
            </div>
            <div>
              <dt>Context</dt>
              <dd>DEV Hacktoberfest Open-Source AI Challenge, Week 3</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>Running nightly · data below is live</dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>
                <a href="https://github.com/AbdulWasih05/nightshift">AbdulWasih05/nightshift</a>
              </dd>
            </div>
          </dl>

          <section className="abstract" aria-labelledby="abstract">
            <h2 id="abstract">Abstract</h2>
            <p>
              Nightshift is a durable overnight workflow (Temporal) that collects new pull requests and issues, finds likely duplicates with
              hybrid vector and keyword search (Tiger Data), and classifies each item with Gemma 3 4B running locally through Ollama and
              Mastra. Every model answer passes a strict output contract and rules enforced in code. The maintainer reviews a one-screen
              digest and approves replies; posting is gated three times over. It costs nothing per night and contributor data stays on the
              laptop.
            </p>
          </section>

          <section className="section" id="problem">
            <h2>Problem</h2>
            <p className="lead">
              Open-source maintainers wake up to a pile: new pull requests, review requests and issues, much of it duplicates, low-effort
              contributions or questions that belong elsewhere.
            </p>
            <p>
              This year Hacktoberfest itself stopped counting pull requests, because that pile burned maintainers out. The work that remains
              is triage: deciding, item by item, whether something needs a human, needs more information, duplicates an earlier report, or is
              small and safe. It is repetitive, it happens every morning, and most of it does not need the maintainer&apos;s judgement, only
              their sign-off.
            </p>
            <p>
              Nightshift takes the first pass, overnight, and leaves the sign-off to the maintainer. The goal is fewer minutes of triage per
              morning, not an agent that acts on its own.
            </p>
          </section>

          <section className="section" id="design">
            <h2>Design</h2>
            <p>
              The pipeline is one Temporal workflow made of five activities. Each activity retries on its own, heartbeats while it works, and
              honours cancellation, so a laptop that sleeps, an Ollama restart or a GitHub rate limit pauses the night instead of losing it.
              Triage runs in chunks of ten; a restarted chunk resumes at the first item without a result.
            </p>
            <PipelineFigure />
            <h3>Classification contract</h3>
            <p>
              For each item the model receives the title, a cleaned body, diff statistics, CI status, test-file presence, the author&apos;s
              account age and prior merged pull requests, and up to three duplicate candidates. It must answer with one JSON object: a bucket,
              a confidence, a one-sentence reason that cites the evidence, and a draft reply under 80 words.
            </p>
            <p>
              The parser, not the model&apos;s JSON mode, is the source of truth. Anything it cannot read becomes <code>NEEDS_HUMAN</code>; no
              item is ever dropped. Rules a 4-billion-parameter model cannot be trusted with are enforced after parsing:
            </p>
            <ul>
              <li>A duplicate must cite one of the candidates actually offered.</li>
              <li>Spam or slop needs two independent tells.</li>
              <li>
                &ldquo;Trivial and safe&rdquo; means under 40 changed lines (dependency bumps from dependency bots excepted), and an unknown
                diff size is never trivial.
              </li>
              <li>A demoted answer loses its draft and its confidence is capped, so no overruled reply can be posted by accident.</li>
            </ul>
            <h3>Model fallback</h3>
            <p>
              Gemma 3 4B runs first, Gemma 3 1B second, an optional hosted model third. A model that errors or times out hands over to the
              next. A model that answers with something unreadable does not: that is a classification result. If no model answers at all,
              nothing is stored and the workflow waits for Ollama to come back.
            </p>
          </section>

          <section className="section" id="safety">
            <h2>Safety model</h2>
            <p>
              The agent never acts on its own. The only write in the codebase is the Post button, and three independent fences stand in front
              of it. Any one of them alone blocks a write to a repository the maintainer does not own.
            </p>
            <ol className="fences">
              <li>
                <strong>GitHub App scope</strong>
                The GitHub App used for posting is installed on one repository. GitHub itself refuses writes anywhere else.
              </li>
              <li>
                <strong>Hard allowlist in code</strong>
                A frozen constant, not a setting. The write client checks the fully resolved request URL; the read-only collector refuses every
                non-GET request. Partner repositories are read-only, always.
              </li>
              <li>
                <strong>Approval of the exact text</strong>
                An approval is bound to a hash of the draft the maintainer read. Posting needs that approval, an open item, and no earlier post
                to the same item; a database constraint claims the post before the network call, so it can never happen twice.
              </li>
            </ol>
            <div className="note">
              <p>
                <strong>No GitHub token in the hosted app.</strong> The dashboard gets a short-lived GitHub token from Auth0 Token Vault at
                the moment the maintainer presses Post, and discards it afterwards.
              </p>
            </div>
            <p>
              Tracing follows the same rule. Sentry receives one span per item and per model call with metadata only (model, tokens, latency,
              bucket); an attribute allowlist drops anything that could carry contributor text.
            </p>
          </section>

          <section className="section" id="duplicates">
            <h2>Duplicate detection</h2>
            <p>
              Each item is embedded locally (title plus the first 400 characters of the cleaned body, <code>nomic-embed-text</code>) and
              matched against a corpus of recent history with two searches fused by reciprocal rank: pgvector cosine similarity and Postgres
              full-text search over title terms.
            </p>
            <p>
              The thresholds come from measuring the data, not from a guess. Within one repository, almost everything looks alike to an
              embedding model, so a candidate reaches the model only when the evidence is strong.
            </p>
            <figure className="table">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Nearest-neighbour cosine</th>
                      <th className="num">Share of temporalio/temporal items</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr><td>≥ 0.80</td><td className="num">89%</td></tr>
                    <tr><td>≥ 0.85</td><td className="num">60%</td></tr>
                    <tr><td>≥ 0.90</td><td className="num">31%</td></tr>
                    <tr><td>≥ 0.93</td><td className="num">19%</td></tr>
                  </tbody>
                </table>
              </div>
              <figcaption>
                Measured on 1,559 temporalio/temporal items. Related-but-different pairs sit at 0.87 to 0.89; a real duplicate request pair
                scored 0.96. The gate: vector alone needs ≥ 0.92; both searches agreeing need ≥ 0.85 and three shared title terms; keyword alone
                needs four shared terms covering 60% of the shorter title.
              </figcaption>
            </figure>
            <p>
              Candidates must also be the same kind (a pull request is not a duplicate of the issue it fixes), older than the item, not already
              referenced by it, and, for pull requests, still open.
            </p>
          </section>

          <section className="section" id="results">
            <h2>Results</h2>
            {!stats ? (
              <p className="empty">The results database is not reachable right now.</p>
            ) : (
              <>
                <p>
                  Every number below is a live query against the database, from each night&apos;s own run. Accuracy is measured only against
                  items the maintainer labelled for that night; &ldquo;n/a&rdquo; means no data yet, not zero.
                </p>
                <div className="stats">
                  <Stat value={fmt(scheduled.length)} label={`scheduled nights${manual.length ? ` (+${manual.length} manual test runs)` : ''}`} />
                  <Stat value={fmt(stats.triaged)} label={`items triaged (${fmt(stats.distinctItems)} distinct)`} />
                  <Stat
                    value={pct(stats.correct, stats.labelled)}
                    label={stats.labelled ? `accuracy on ${fmt(stats.labelled)} human-labelled items` : 'accuracy (no labels yet)'}
                  />
                  <Stat value={stats.medianLatencyS === null ? null : `${stats.medianLatencyS.toFixed(0)} s`} label="median time per item, laptop GPU" />
                  <Stat value={fmt(stats.parseFailures)} label="parse failures (routed to a human)" />
                  <Stat value={stats.modelPaths.some((m) => m.model_path === 'hosted') ? 'mixed' : '$0.00'} label="model cost per night" />
                </div>
                <figure className="table">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Bucket</th>
                          <th className="num">Items</th>
                          <th className="num">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.buckets.map((b) => (
                          <tr key={b.bucket}>
                            <td>{b.bucket.replaceAll('_', ' ').toLowerCase()}</td>
                            <td className="num">{fmt(b.n)}</td>
                            <td className="num">{pct(b.n, stats!.triaged)}</td>
                          </tr>
                        ))}
                        {!stats.buckets.length && (
                          <tr>
                            <td colSpan={3} className="empty">No triaged items yet.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <figcaption>
                    How the model bucketed every item across all nights. {fmt(stats.withDuplicateCandidates)} items reached the model with at
                    least one duplicate candidate. Model path: {stats.modelPaths.map((m) => `${m.model_path} ${fmt(m.n)}`).join(', ') || 'n/a'}.
                    Tokens: {fmt(stats.tokensIn)} in, {fmt(stats.tokensOut)} out.
                  </figcaption>
                </figure>
                <figure className="table">
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Night</th>
                          <th>Started (UTC)</th>
                          <th>Trigger</th>
                          <th>Status</th>
                          <th className="num">Triaged</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.nights.map((n) => (
                          <tr key={n.id}>
                            <td>{n.id}</td>
                            <td>{new Date(n.started_at).toISOString().slice(0, 16).replace('T', ' ')}</td>
                            <td>{n.trigger}</td>
                            <td>{n.status}</td>
                            <td className="num">{fmt(n.triaged)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <figcaption>
                    Every run, including smoke tests and the one that failed. Manual runs are listed but not counted as nights. Replies approved:{' '}
                    {fmt(stats.approvals)}; posted to GitHub: {fmt(stats.posts)}.
                  </figcaption>
                </figure>
              </>
            )}
          </section>

          <section className="section" id="failures">
            <h2>Failures and what changed</h2>
            <p>Each of these happened during the build and is logged with its fix in the repository&apos;s decision log.</p>
            <div className="incidents">
              <Incident when="Oct 21 · code review" title="A way past the write allowlist">
                The first write guard checked the owner and repository parameters, not the URL actually sent. A request written as a literal URL
                to a partner repository passed. The guard now checks the resolved URL, and the bypass is a regression test.
              </Incident>
              <Incident when="Oct 22 · first real triage" title="A 414-line concurrency fix called trivial">
                Gemma 3 4B put a 414-line change in &ldquo;trivial and safe&rdquo; at 0.95 confidence. The fix was not a better prompt: the
                parser now enforces what trivial means.
              </Incident>
              <Incident when="Oct 22 · calibration" title="Every item looked like a duplicate">
                The first similarity threshold would have offered a duplicate candidate for 89% of items. Measuring the distribution set the real
                gate, and a false duplicate on a common phrase added the coverage rule.
              </Incident>
              <Incident when="Oct 22 · workflow review" title="An Ollama outage recorded as verdicts">
                With Ollama down, every item would have been filed as &ldquo;needs a human&rdquo; and the night reported success. An outage now
                stores nothing and the workflow waits. On Oct 23 Ollama did go down mid-night; the night paused and resumed with nothing lost.
              </Incident>
              <Incident when="Oct 22 · test run" title="A stale worker ran a test night uncapped">
                A stopped worker&apos;s child process kept running old code and turned a four-item test into a 200-item night. It was
                terminated and marked failed; the items carried over. Workers now start only through a launcher that detects a running one.
              </Incident>
              <Incident when="Oct 22–23 · overnight" title="The laptop restarted mid-night">
                Forty minutes into a night the machine restarted and nothing came back up until the next day. Temporal&apos;s saved state let
                the night resume where it stopped.
              </Incident>
            </div>
          </section>

          <section className="section" id="reproduce">
            <h2>Reproduce</h2>
            <p>Laptop mode needs Node 20+, pnpm, Ollama and a Postgres with pgvector (Tiger Data or Docker).</p>
            <pre className="draft-text">{`pnpm install
ollama pull gemma3:4b && ollama pull gemma3:1b && ollama pull nomic-embed-text
pnpm db:migrate
pnpm night            # start the stack and run once, two minutes from now
pnpm nightshift digest
pnpm nightshift review   # label the night: the accuracy numbers above`}</pre>
            <p>
              The schedule is the maintainer&apos;s: <code>nightshift schedule --at 02:00</code>, a midday run, or a summary on demand with{' '}
              <code>nightshift run</code>.
            </p>
          </section>

          <footer className="doc-foot">
            Built for the DEV Hacktoberfest Open-Source AI Challenge, Week 3. Stack: Gemma 3 via Ollama, Mastra, Temporal, Tiger Data, Auth0
            for AI Agents, Sentry, Render.
          </footer>
        </article>
      </div>
    </>
  );
}

function Stat({ value, label }: { value: string | null; label: string }) {
  return (
    <div className="stat">
      <div className={`stat-value ${value === null ? 'na' : ''}`}>{value ?? 'n/a'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Incident({ when, title, children }: { when: string; title: string; children: React.ReactNode }) {
  return (
    <div className="incident">
      <p className="when">{when}</p>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
