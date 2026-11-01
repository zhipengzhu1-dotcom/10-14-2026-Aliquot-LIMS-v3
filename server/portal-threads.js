// Client portal conversations: a thread per subject, its messages, and the system notices posted into the thread of a
// Submission or a Request when it moves. The portal routes, Submissions and intake review all write here.

import { get, run } from './db.js';
import { bad } from './http.js';
import { getSettings } from './settings.js';
import { nowIso } from './util.js';

export function createThread({ client_id, subject, submission_id = null, request_id = null, sample_id = null }) {
  const t = nowIso();
  return Number(run(
    'INSERT INTO portal_threads (client_id, subject, submission_id, request_id, sample_id, created_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    client_id, subject, submission_id, request_id, sample_id, t, t,
  ).lastInsertRowid);
}

export function postMessage(threadId, { portalUser = null, user = null, body, kind = 'message' }) {
  const text = String(body ?? '').trim();
  if (!text) throw bad('Write a message first');
  if (text.length > 10000) throw bad('That message is too long (max 10 000 characters)');
  const t = nowIso();
  const author = portalUser ? portalUser.full_name : user ? user.full_name : getSettings().lab_name;
  run('INSERT INTO portal_messages (thread_id, portal_user_id, user_id, author_name, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    threadId, portalUser?.id ?? null, user?.id ?? null, author, text, kind, t);
  // Whoever writes has, by definition, read the thread up to now.
  if (portalUser) run('UPDATE portal_threads SET last_message_at = ?, client_read_at = ?, status = ? WHERE id = ?', t, t, 'Open', threadId);
  else if (user) run('UPDATE portal_threads SET last_message_at = ?, lab_read_at = ? WHERE id = ?', t, t, threadId);
  else run('UPDATE portal_threads SET last_message_at = ? WHERE id = ?', t, threadId);
}

/** The thread linked to a submission or request, as `{ submission_id }` or `{ request_id }`, or undefined. */
export const threadOf = (where) => get(`SELECT id FROM portal_threads WHERE ${where.submission_id ? 'submission_id' : 'request_id'} = ?`, where.submission_id || where.request_id);

/** System notice (status changes) posted into the thread linked to a submission or request. */
export function notice(where, body) {
  const thread = threadOf(where);
  if (thread) postMessage(thread.id, { body, kind: 'event' });
}
