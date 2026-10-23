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

function Item({ it, night }: { it: DashItem; night: string }) {
  const own = it.repo === OWN_REPO;
  const approved = it.decision === 'approve' || it.decision === 'edit';
  const path = it.kind === 'pr' ? 'pull' : 'issues';
  const shown = approved && it.decided_text ? it.decided_text : it.draft_reply;
  return (
    <article className={`item b-${it.bucket}`} aria-labelledby={`t-${it.triage_id}`}>
      <div className="item-head">
        <span className="badge">{it.bucket.replaceAll('_', ' ').toLowerCase()}</span>
        <a href={`https://github.com/${it.repo}/${path}/${it.number}`} target="_blank" rel="noreferrer">
          {it.repo}#{it.number}
        </a>
        <span className="fine">
          {it.kind === 'pr' ? 'pull request' : 'issue'} · {it.model_path}
          {it.confidence !== null ? ` · confidence ${it.confidence}` : ''}
          {it.parse_ok ? '' : ' · parse failure'}
        </span>
      </div>
      <h3 id={`t-${it.triage_id}`}>{it.title}</h3>
      <p className="why">{it.reason}</p>
      {it.evidence?.length > 0 && <p className="fine">Evidence: {it.evidence.join(' · ')}</p>}
      {it.duplicates?.length > 0 && (
        <p className="fine">Duplicate candidates: {it.duplicates.map((d) => `#${d.number} (${d.why})`).join(' · ')}</p>
      )}

      {it.draft_reply && shown && (
        <div className="draft">
          <p className="draft-label">{approved ? (it.decision === 'edit' ? 'Your edited reply' : 'Approved reply') : 'Drafted reply'}</p>
          <div className="draft-text">{shown}</div>
          {it.posted_url ? (
            <p className="fine">
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
                <span className="fine">Read-only repository: your decision is recorded, nothing is posted.</span>
              )}
              <details className="edit">
                <summary>Edit before approving</summary>
                <form action={editAction}>
                  <Hidden it={it} night={night} />
                  <label className="fine" htmlFor={`e-${it.triage_id}`}>
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
