import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { auth0, isAllowed } from '@/lib/auth0';
import { listNights, nightItems, type DashItem } from '@/lib/data';
import { Topbar } from '@/components/Topbar';
import { Toc } from '@/components/Toc';
import { approveAction, editAction, postAction, skipAction } from '../actions';

export const dynamic = 'force-dynamic';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
const OWN_REPO = 'AbdulWasih05/nightshift';
const DRAFT_BUCKETS = ['DUPLICATE', 'SPAM_OR_SLOP', 'OUT_OF_SCOPE', 'NEEDS_TESTS_OR_INFO'];
const utc = (d: Date) => new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default async function Review({ searchParams }: { searchParams: Promise<{ night?: string; msg?: string }> }) {
  const session = await auth0.getSession();
  if (!session) redirect('/auth/login?returnTo=/review');
  if (!isAllowed(session.user)) return <Denied user={session.user} />;

  const { night, msg } = await searchParams;
  const nights = await listNights();
  const current = nights.find((n) => String(n.id) === night) ?? nights.find((n) => n.status !== 'running') ?? nights[0];
  const items = current ? await nightItems(current.id) : [];
  const human = items.filter((i) => i.bucket === 'NEEDS_HUMAN');
  const drafts = items.filter((i) => DRAFT_BUCKETS.includes(i.bucket) && i.draft_reply);
  const trivial = items.filter((i) => i.bucket === 'TRIVIAL_SAFE');
  const other = items.filter((i) => !human.includes(i) && !drafts.includes(i) && !trivial.includes(i));
  const nightId = String(current?.id ?? '');

  const sections = [
    ['summary', 'Summary'],
    ['needs-you', `Needs you (${human.length})`],
    ['drafts', `Drafted replies (${drafts.length})`],
    ['trivial', `Trivial and safe (${trivial.length})`],
    ...(other.length ? [['other', `Classified, no draft (${other.length})`]] : []),
  ];

  return (
    <>
      <Topbar loggedIn allowed />
      <div className="doc">
        <Toc items={sections.map(([id, title]) => ({ id: id!, title: title! }))} />

        <article className="doc-main">
          <p className="kicker">Triage report</p>
          <h1 className="doc-title">{current ? `Night ${current.id}` : 'No nights yet'}</h1>
          <p className="doc-subtitle">
            Nothing was posted, labelled or closed without you. Partner repositories are read-only; replies can only be posted to{' '}
            <code>{OWN_REPO}</code>, after you approve the exact text.
          </p>

          <form className="night-picker" method="get">
            <label htmlFor="night">Night</label>
            <select id="night" name="night" defaultValue={current?.id}>
              {nights.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id} · {utc(n.started_at)} · {n.trigger} · {n.status}
                </option>
              ))}
            </select>
            <button className="btn">Show</button>
          </form>

          {msg && (
            <p className="flash" role="status">
              {msg}
            </p>
          )}

          {current && (
            <>
              <dl className="meta">
                <div>
                  <dt>Started</dt>
                  <dd>{utc(current.started_at)}</dd>
                </div>
                <div>
                  <dt>Finished</dt>
                  <dd>{current.finished_at ? utc(current.finished_at) : 'still running'}</dd>
                </div>
                <div>
                  <dt>Trigger · status</dt>
                  <dd>
                    {current.trigger} · {current.status}
                  </dd>
                </div>
                <div>
                  <dt>Prompt</dt>
                  <dd>{current.prompt_version}</dd>
                </div>
              </dl>

              <section className="section" id="summary">
                <h2>Summary</h2>
                <div className="stats">
                  <Stat value={human.length} label="need you" />
                  <Stat value={drafts.length} label="drafted replies waiting" />
                  <Stat value={trivial.length} label="trivial and safe" />
                  <Stat value={items.length} label="triaged this night" />
                </div>
              </section>

              <Group id="needs-you" title="Needs you" items={human} night={nightId} empty="Nothing needs you from this night." />
              <Group id="drafts" title="Drafted replies" items={drafts} night={nightId} empty="No drafted replies." />
              <Group id="trivial" title="Trivial and safe" items={trivial} night={nightId} empty="Nothing trivial this night." />
              {other.length > 0 && <Group id="other" title="Classified, no draft" items={other} night={nightId} empty="" />}
            </>
          )}
        </article>
      </div>
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Group({ id, title, items, night, empty }: { id: string; title: string; items: DashItem[]; night: string; empty: string }) {
  return (
    <section className="section" id={id}>
      <h2>
        {title} ({items.length})
      </h2>
      {items.length ? items.map((it) => <Item key={it.triage_id} it={it} night={night} />) : <p className="empty">{empty}</p>}
    </section>
  );
}

function Hidden({ it, night }: { it: DashItem; night: string }) {
  return (
    <>
      <input type="hidden" name="triageId" value={it.triage_id} />
      <input type="hidden" name="night" value={night} />
    </>
  );
}

// Rules from packages/core/src/triage/contract.ts prefix the model's reason when they overrule it. Split them so
// the reader sees our rule and the model's reasoning separately.
const RULES: { re: RegExp; label: (m: RegExpMatchArray) => string }[] = [
  { re: /^model said trivial but the diff is (\d+) lines: /, label: (m) => `"Trivial and safe" means under 40 changed lines; this diff has ${m[1]}.` },
  { re: /^model said trivial but the diff size is unknown: /, label: () => 'A pull request of unknown size is never "trivial and safe".' },
  { re: /^model said duplicate without citing a candidate: /, label: () => 'A duplicate must cite one of the candidates actually offered.' },
  { re: /^model said spam with fewer than two tells: /, label: () => 'Spam or slop needs two independent tells.' },
];

function splitReason(reason: string): { rule: string | null; model: string } {
  for (const r of RULES) {
    const m = reason.match(r.re);
    if (m) return { rule: r.label(m), model: reason.slice(m[0].length) };
  }
  return { rule: null, model: reason };
}

function years(days: number) {
  return days >= 365 ? `${(days / 365).toFixed(1)} yr old account` : `${days} day old account`;
}

/** Facts from the collector (GitHub's data), not from the model. */
function Facts({ it }: { it: DashItem }) {
  const facts: { text: string; tone?: 'good' | 'bad' }[] = [];
  if (it.kind === 'pr') {
    if (it.additions !== null) facts.push({ text: `+${it.additions} / −${it.deletions ?? 0}` });
    if (it.files_changed !== null) facts.push({ text: `${it.files_changed} file${it.files_changed === 1 ? '' : 's'}` });
    if (it.has_tests !== null) facts.push({ text: it.has_tests ? 'touches tests' : 'no tests', tone: it.has_tests ? 'good' : 'bad' });
    if (it.ci_status && it.ci_status !== 'none') {
      facts.push({ text: `CI ${it.ci_status === 'success' ? 'passing' : it.ci_status === 'failure' ? 'failing' : 'pending'}`, tone: it.ci_status === 'success' ? 'good' : it.ci_status === 'failure' ? 'bad' : undefined });
    }
  }
  facts.push({ text: `@${it.author}` });
  if (it.author_account_age_days !== null) facts.push({ text: years(it.author_account_age_days) });
  if (it.author_prior_merged !== null) facts.push({ text: `${it.author_prior_merged} prior merged PR${it.author_prior_merged === 1 ? '' : 's'}` });
  return (
    <ul className="facts" aria-label="Facts from GitHub">
      {facts.map((f) => (
        <li key={f.text} className={f.tone ? `fact-${f.tone}` : undefined}>
          {f.text}
        </li>
      ))}
    </ul>
  );
}

function Item({ it, night }: { it: DashItem; night: string }) {
  const own = it.repo === OWN_REPO;
  const approved = it.decision === 'approve' || it.decision === 'edit';
  const path = it.kind === 'pr' ? 'pull' : 'issues';
  const shown = approved && it.decided_text ? it.decided_text : it.draft_reply;
  const { rule, model } = splitReason(it.reason);
  // Drop evidence that just repeats the title or body; keep what the model actually pointed at.
  const evidence = (it.evidence ?? []).filter((e) => !/^(title|body)\s*[:=]/i.test(e));
  return (
    <article className="item" aria-labelledby={`t-${it.triage_id}`}>
      <header className="item-head">
        <span className={`status s-${it.bucket}`}>{it.bucket.replaceAll('_', ' ').toLowerCase()}</span>
        <a className="item-ref" href={`https://github.com/${it.repo}/${path}/${it.number}`} target="_blank" rel="noreferrer">
          {it.repo}#{it.number}
        </a>
        <span className="item-meta">
          {it.kind === 'pr' ? 'PR' : 'Issue'} · {it.model_path}
          {it.confidence !== null ? ` · ${Math.round(it.confidence * 100)}%` : ''}
          {it.parse_ok ? '' : ' · parse failure'}
        </span>
      </header>
      <h3 id={`t-${it.triage_id}`}>{it.title}</h3>
      <Facts it={it} />

      {rule && (
        <p className="overruled">
          <span>Overruled by rule</span>
          {rule}
        </p>
      )}
      <div className="reasoning">
        <p className="label">{rule ? "Model's reasoning" : 'Why'}</p>
        <p className="clamp">{model}</p>
      </div>

      {(evidence.length > 0 || it.duplicates?.length > 0) && (
        <details className="more">
          <summary>
            {evidence.length > 0 && `Model's evidence (${evidence.length})`}
            {evidence.length > 0 && it.duplicates?.length > 0 && ' · '}
            {it.duplicates?.length > 0 && `Duplicate candidates (${it.duplicates.length})`}
          </summary>
          {evidence.length > 0 && (
            <ul className="evidence">
              {evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {it.duplicates?.length > 0 && (
            <ul className="evidence">
              {it.duplicates.map((d) => (
                <li key={d.number}>
                  <a href={`https://github.com/${it.repo}/${path}/${d.number}`} target="_blank" rel="noreferrer">
                    #{d.number}
                  </a>{' '}
                  {d.title} <span className="item-meta">({d.why})</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {it.draft_reply && shown && (
        <div className="draft">
          <p className="label">{approved ? (it.decision === 'edit' ? 'Your edited reply' : 'Approved reply') : 'Drafted reply'}</p>
          <div className="draft-text">{shown}</div>
          {it.posted_url ? (
            <p className="item-meta">
              Posted: <a href={it.posted_url}>{it.posted_url}</a>
            </p>
          ) : (
            <div className="actions">
              <form action={approveAction}>
                <Hidden it={it} night={night} />
                <input type="hidden" name="hash" value={hash(it.draft_reply)} />
                <button className="btn" disabled={approved}>
                  {approved ? 'Approved' : 'Approve'}
                </button>
              </form>
              <form action={skipAction}>
                <Hidden it={it} night={night} />
                <button className="btn">{it.decision === 'skip' ? 'Skipped' : 'Skip'}</button>
              </form>
              {own ? (
                <form action={postAction}>
                  <Hidden it={it} night={night} />
                  <button className="btn primary" disabled={!approved || it.state !== 'open'} title={approved ? 'Post as a comment' : 'Approve first'}>
                    Post to GitHub
                  </button>
                </form>
              ) : (
                <span className="item-meta">Read-only repository: your decision is recorded, nothing is posted.</span>
              )}
              <details className="edit">
                <summary>Edit before approving</summary>
                <form action={editAction}>
                  <Hidden it={it} night={night} />
                  <label className="item-meta" htmlFor={`e-${it.triage_id}`}>
                    Your version of the reply
                  </label>
                  <textarea id={`e-${it.triage_id}`} name="text" defaultValue={shown} />
                  <button className="btn">Save edit and approve</button>
                </form>
              </details>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Denied({ user }: { user: { sub?: string; nickname?: string; name?: string; email?: string } }) {
  return (
    <>
      <Topbar loggedIn allowed={false} />
      <main className="center-page">
        <div className="card">
          <h1>Not on the maintainer list</h1>
          <p>This account cannot see drafts or approve anything.</p>
          <p className="fine">
            Logged in as <code>{user.nickname ?? user.name ?? 'unknown'}</code> · user id <code>{user.sub}</code> · email{' '}
            <code>{user.email ?? 'none (GitHub did not share it)'}</code>
          </p>
          <p className="fine">To allow this account, add the user id to ALLOWED_USERS (or a verified email to ALLOWED_EMAILS) and restart.</p>
        </div>
      </main>
    </>
  );
}
