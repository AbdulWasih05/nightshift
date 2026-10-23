import { createHash } from 'node:crypto';
import { auth0, isAllowed } from '@/lib/auth0';
import { listNights, nightItems, type DashItem } from '@/lib/data';
import { approveAction, editAction, postAction, skipAction } from './actions';

export const dynamic = 'force-dynamic';

const hash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);
const OWN_REPO = 'AbdulWasih05/nightshift';
const DRAFT_BUCKETS = ['DUPLICATE', 'SPAM_OR_SLOP', 'OUT_OF_SCOPE', 'NEEDS_TESTS_OR_INFO'];

export default async function Page({ searchParams }: { searchParams: Promise<{ night?: string; msg?: string }> }) {
  const session = await auth0.getSession();
  if (!session) {
    return (
      <main className="center">
        <h1>Nightshift</h1>
        <p className="muted">The maintainer&apos;s night shift. It drafts, you decide. Nothing is posted without your approval.</p>
        <a className="btn primary" href="/auth/login">Log in</a>
      </main>
    );
  }
  if (!isAllowed(session.user.email)) {
    return (
      <main className="center">
        <h1>Not on the maintainer list</h1>
        <p className="muted">{session.user.email} cannot see drafts or approve anything.</p>
        <a className="btn" href="/auth/logout">Log out</a>
      </main>
    );
  }

  const { night, msg } = await searchParams;
  const nights = await listNights();
  const current = nights.find((n) => String(n.id) === night) ?? nights.find((n) => n.status !== 'running') ?? nights[0];
  const items = current ? await nightItems(current.id) : [];
  const human = items.filter((i) => i.bucket === 'NEEDS_HUMAN');
  const drafts = items.filter((i) => DRAFT_BUCKETS.includes(i.bucket) && i.draft_reply);
  const trivial = items.filter((i) => i.bucket === 'TRIVIAL_SAFE');

  return (
    <main>
      <header>
        <div>
          <h1>Nightshift</h1>
          <p className="muted">Nothing was posted, labelled or closed without you. Partner repos are read-only.</p>
        </div>
        <nav>
          <a className="btn" href="/auth/connect?connection=github&returnTo=/">Connect GitHub</a>
          <a className="btn" href="/auth/logout">Log out</a>
        </nav>
      </header>

      <form className="nights" method="get">
        <label>
          Night{' '}
          <select name="night" defaultValue={current?.id}>
            {nights.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id} · {new Date(n.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · {n.trigger} · {n.status}
              </option>
            ))}
          </select>
        </label>
        <button className="btn">Show</button>
      </form>

      {msg && <p className="flash">{msg}</p>}

      {current && (
        <p className="headline">
          <strong>{human.length} need you</strong> · {drafts.length} drafted replies waiting for one click · {trivial.length} trivial and safe
          {current.status === 'running' && <span className="muted"> (night still running)</span>}
        </p>
      )}

      {items.map((it) => (
        <Item key={it.triage_id} it={it} night={String(current!.id)} />
      ))}
      {!items.length && <p className="muted">No triaged items for this night yet.</p>}
    </main>
  );
}

function Item({ it, night }: { it: DashItem; night: string }) {
  const own = it.repo === OWN_REPO;
  const approved = it.decision === 'approve' || it.decision === 'edit';
  const path = it.kind === 'pr' ? 'pull' : 'issues';
  return (
    <article className={`item b-${it.bucket}`}>
      <div className="row">
        <span className="bucket">{it.bucket.replaceAll('_', ' ')}</span>
        <a href={`https://github.com/${it.repo}/${path}/${it.number}`} target="_blank" rel="noreferrer">
          {it.repo}#{it.number}
        </a>
        <span className="muted">{it.kind.toUpperCase()} · {it.model_path}{it.parse_ok ? '' : ' · parse failure'}{it.confidence !== null ? ` · ${it.confidence}` : ''}</span>
      </div>
      <h3>{it.title}</h3>
      <p>{it.reason}</p>
      {it.evidence?.length > 0 && <p className="muted small">Evidence: {it.evidence.join(' · ')}</p>}
      {it.duplicates?.length > 0 && (
        <p className="muted small">Duplicate candidates: {it.duplicates.map((d) => `#${d.number} (${d.why})`).join(' · ')}</p>
      )}

      {it.draft_reply && (
        <div className="draft">
          <pre>{approved && it.decided_text ? it.decided_text : it.draft_reply}</pre>
          {it.posted_url ? (
            <p>
              Posted: <a href={it.posted_url}>{it.posted_url}</a>
            </p>
          ) : (
            <div className="actions">
              <form action={approveAction}>
                <input type="hidden" name="triageId" value={it.triage_id} />
                <input type="hidden" name="night" value={night} />
                <input type="hidden" name="hash" value={hash(it.draft_reply)} />
                <button className="btn" disabled={approved}>{approved ? 'Approved' : 'Approve'}</button>
              </form>
              <form action={skipAction}>
                <input type="hidden" name="triageId" value={it.triage_id} />
                <input type="hidden" name="night" value={night} />
                <button className="btn">Skip</button>
              </form>
              {own && (
                <form action={postAction}>
                  <input type="hidden" name="triageId" value={it.triage_id} />
                  <input type="hidden" name="night" value={night} />
                  <button className="btn primary" disabled={!approved || it.state !== 'open'} title={approved ? 'Post as a comment' : 'Approve first'}>
                    Post
                  </button>
                </form>
              )}
              {!own && <span className="muted small">read-only repo: never posted</span>}
              <details>
                <summary>Edit</summary>
                <form action={editAction}>
                  <input type="hidden" name="triageId" value={it.triage_id} />
                  <input type="hidden" name="night" value={night} />
                  <textarea name="text" defaultValue={it.decided_text ?? it.draft_reply} rows={5} />
                  <button className="btn">Save edit and approve</button>
                </form>
              </details>
            </div>
          )}
          {it.decision === 'skip' && <p className="muted small">Skipped.</p>}
        </div>
      )}
    </article>
  );
}
