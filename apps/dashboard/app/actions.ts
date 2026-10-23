'use server';

import { redirect } from 'next/navigation';
import { getPool } from '@nightshift/core/db';
import { createWriteClient } from '@nightshift/core/github';
import { approvalTarget, postApproved, recordApproval } from '@nightshift/core/review';
import { auth0, isAllowed } from '@/lib/auth0';

async function maintainer(): Promise<string> {
  const session = await auth0.getSession();
  if (!session) redirect('/auth/login');
  if (!isAllowed(session.user.email)) throw new Error('not allowed');
  return session.user.email!;
}

function back(night: string, msg: string): never {
  redirect(`/?night=${encodeURIComponent(night)}&msg=${encodeURIComponent(msg)}`);
}

function ids(form: FormData) {
  return { id: Number(form.get('triageId')), night: String(form.get('night') ?? '') };
}

export async function approveAction(form: FormData) {
  const actor = await maintainer();
  const { id, night } = ids(form);
  try {
    // The hash of the full draft the page rendered: if the draft changed since, the approval is refused.
    await recordApproval(getPool(), { triageId: id, action: 'approve', shownHash: String(form.get('hash')), actor });
  } catch (err) {
    back(night, `Not approved: ${(err as Error).message}`);
  }
  back(night, `Approved #${id}. Nothing is posted until you press Post.`);
}

export async function editAction(form: FormData) {
  const actor = await maintainer();
  const { id, night } = ids(form);
  try {
    await recordApproval(getPool(), { triageId: id, action: 'edit', finalText: String(form.get('text') ?? ''), actor });
  } catch (err) {
    back(night, `Edit not saved: ${(err as Error).message}`);
  }
  back(night, `Edited and approved #${id}.`);
}

export async function skipAction(form: FormData) {
  const actor = await maintainer();
  const { id, night } = ids(form);
  await recordApproval(getPool(), { triageId: id, action: 'skip', actor });
  back(night, `Skipped #${id}.`);
}

export async function postAction(form: FormData) {
  const actor = await maintainer();
  const { id, night } = ids(form);
  let url = '';
  try {
    const t = await approvalTarget(getPool(), id);
    if (!t.writable) back(night, `${t.repo} is read-only. Nightshift never posts there.`);
    // Token Vault: a short-lived GitHub token for this one request. No GitHub token is stored in this app.
    const { token } = await auth0.getAccessTokenForConnection({ connection: 'github' });
    url = await postApproved(getPool(), createWriteClient(t.repo, token), { triageId: id, actor });
  } catch (err) {
    const msg = (err as Error).message;
    if ((err as Error & { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err;
    back(night, /connection|federated|token/i.test(msg) ? `Connect GitHub first (top right). ${msg}` : `Not posted: ${msg}`);
  }
  back(night, `Posted: ${url}`);
}
