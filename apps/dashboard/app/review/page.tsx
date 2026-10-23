import { createHash } from 'node:crypto';
import { ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleX, FileDiff, Files, FlaskConical, GitPullRequest, TriangleAlert, User } from 'lucide-react';
import { redirect } from 'next/navigation';
import { auth0, githubConnected, isAllowed } from '@/lib/auth0';
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
  const linked = await githubConnected();
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
      <Topbar loggedIn allowed current="review" githubLinked={linked} />
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
      {items.length ? (
        <ol className="rows">
          {items.map((it) => (
            <Item key={it.triage_id} it={it} night={night} />
          ))}
        </ol>
      ) : (
        <p className="empty">{empty}</p>
      )}
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

const BADGE: Record<string, { label: string; tone: string }> = {
  NEEDS_HUMAN: { label: 'Needs you', tone: 'amber' },
  NEEDS_TESTS_OR_INFO: { label: 'Needs tests or info', tone: 'blue' },
  DUPLICATE: { label: 'Duplicate', tone: 'purple' },
  TRIVIAL_SAFE: { label: 'Trivial and safe', tone: 'green' },
  SPAM_OR_SLOP: { label: 'Spam or slop', tone: 'gray' },
  OUT_OF_SCOPE: { label: 'Out of scope', tone: 'gray' },
};

const I = { size: 14, strokeWidth: 1.75, 'aria-hidden': true } as const;

/** One muted line of facts from GitHub (the collector), not from the model. */
function Meta({ it, path }: { it: DashItem; path: string }) {
  const age = it.author_account_age_days;
  const parts: React.ReactNode[] = [
    <a key="ref" className="row-ref" href={`https://github.com/${it.repo}/${path}/${it.number}`} target="_blank" rel="noreferrer">
      {it.repo}#{it.number}
    </a>,
  ];
  if (it.kind === 'pr') {
    if (it.additions !== null)
      parts.push(
        <span key="diff" className="meta-item">
          <FileDiff {...I} />
          <span className="add">+{it.additions}</span> <span className="del">−{it.deletions ?? 0}</span>
        </span>,
      );
    if (it.files_changed !== null)
      parts.push(
        <span key="files" className="meta-item">
          <Files {...I} />
          {it.files_changed} file{it.files_changed === 1 ? '' : 's'}
        </span>,
      );
    if (it.has_tests !== null)
      parts.push(
        <span key="tests" className={`meta-item ${it.has_tests ? 'ok' : 'bad'}`}>
          <FlaskConical {...I} />
          {it.has_tests ? 'tests' : 'no tests'}
        </span>,
      );
    if (it.ci_status && it.ci_status !== 'none') {
      const CI = it.ci_status === 'success' ? CircleCheck : it.ci_status === 'failure' ? CircleX : CircleDashed;
      parts.push(
        <span key="ci" className={`meta-item ${it.ci_status === 'success' ? 'ok' : it.ci_status === 'failure' ? 'bad' : ''}`}>
          <CI {...I} />
          CI {it.ci_status === 'success' ? 'passing' : it.ci_status === 'failure' ? 'failing' : 'pending'}
        </span>,
      );
    }
  }
  const history = [
    age !== null ? (age >= 365 ? `${(age / 365).toFixed(1)} yr` : `${age} d`) : null,
    it.author_prior_merged !== null ? `${it.author_prior_merged} merged` : null,
  ].filter(Boolean);
  parts.push(
    <span key="author" className="meta-item">
      <User {...I} />@{it.author}
      {history.length > 0 && <span className="dim">&nbsp;({history.join(', ')})</span>}
    </span>,
  );
  return <div className="row-meta">{parts}</div>;
}

function Item({ it, night }: { it: DashItem; night: string }) {
  const own = it.repo === OWN_REPO;
  const approved = it.decision === 'approve' || it.decision === 'edit';
  const path = it.kind === 'pr' ? 'pull' : 'issues';
  const shown = approved && it.decided_text ? it.decided_text : it.draft_reply;
  const { rule, model } = splitReason(it.reason);
  const evidence = (it.evidence ?? []).filter((e) => !/^(title|body)\s*[:=]/i.test(e));
  const badge = BADGE[it.bucket] ?? { label: it.bucket, tone: 'gray' };
  const Kind = it.kind === 'pr' ? GitPullRequest : CircleDot;
  return (
    <li className="row" aria-labelledby={`t-${it.triage_id}`}>
      <div className="row-head">
        <Kind {...I} className="row-kind" aria-label={it.kind === 'pr' ? 'Pull request' : 'Issue'} />
        <h3 id={`t-${it.triage_id}`}>{it.title}</h3>
        <span className={`badge badge-${badge.tone}`}>{badge.label}</span>
      </div>
      <Meta it={it} path={path} />

      {rule && (
        <div className="callout callout-warning" role="note">
          <TriangleAlert {...I} />
          <p>
            <strong>Overruled by a rule.</strong> {rule}
          </p>
        </div>
      )}
      <p className="row-reason">
        {rule && <span className="dim">The model said: </span>}
        {model}
      </p>

      {it.draft_reply && shown && (
        <div className="panel">
          <div className="panel-head">
            <span>{approved ? (it.decision === 'edit' ? 'Your edited reply' : 'Approved reply') : 'Drafted reply'}</span>
            {it.posted_url && (
              <a href={it.posted_url} target="_blank" rel="noreferrer">
                View on GitHub
              </a>
            )}
          </div>
          <div className="panel-body">{shown}</div>
          {!it.posted_url && (
            <div className="panel-foot">
              <form action={approveAction}>
                <Hidden it={it} night={night} />
                <input type="hidden" name="hash" value={hash(it.draft_reply)} />
                <button className="btn btn-sm" disabled={approved}>
                  {approved ? 'Approved' : 'Approve'}
                </button>
              </form>
              <form action={skipAction}>
                <Hidden it={it} night={night} />
                <button className="btn btn-sm">{it.decision === 'skip' ? 'Skipped' : 'Skip'}</button>
              </form>
              <details className="edit">
                <summary className="btn btn-sm">Edit</summary>
                <form action={editAction}>
                  <Hidden it={it} night={night} />
                  <label className="dim" htmlFor={`e-${it.triage_id}`}>
                    Your version of the reply
                  </label>
                  <textarea id={`e-${it.triage_id}`} name="text" defaultValue={shown} />
                  <button className="btn btn-sm">Save and approve</button>
                </form>
              </details>
              <span className="spacer" />
              {own ? (
                <form action={postAction}>
                  <Hidden it={it} night={night} />
                  <button className="btn btn-sm primary" disabled={!approved || it.state !== 'open'} title={approved ? 'Post as a comment' : 'Approve first'}>
                    Post to GitHub
                  </button>
                </form>
              ) : (
                <span className="dim small">Read-only repo · never posted</span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="row-foot">
        <span>
          {it.model_path}
          {it.confidence !== null ? ` · ${Math.round(it.confidence * 100)}% confidence` : ''}
          {it.parse_ok ? '' : ' · parse failure'}
        </span>
        {(evidence.length > 0 || it.duplicates?.length > 0) && (
          <details className="more">
            <summary>
              <ChevronRight {...I} className="chev" />
              Details
            </summary>
            {evidence.length > 0 && (
              <>
                <p className="more-title">Model&apos;s evidence</p>
                <ul>
                  {evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </>
            )}
            {it.duplicates?.length > 0 && (
              <>
                <p className="more-title">Duplicate candidates</p>
                <ul>
                  {it.duplicates.map((d) => (
                    <li key={d.number}>
                      <a href={`https://github.com/${it.repo}/${path}/${d.number}`} target="_blank" rel="noreferrer">
                        #{d.number}
                      </a>{' '}
                      {d.title} <span className="dim">({d.why})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        )}
      </div>
    </li>
  );
}

function Denied({ user }: { user: { sub?: string; nickname?: string; name?: string; email?: string } }) {
  return (
    <>
      <Topbar loggedIn allowed={false} current="review" />
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
