import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { env } from './env.server.ts'

// SQLite holds app data only: users, auth sessions, article metadata and the
// conversation -> ModelRiver session mapping. Messages live in ModelRiver.
// Exported for tests that start from an older version.
export const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE articles (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    file TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    visitor_token_hash TEXT NOT NULL,
    modelriver_session_id TEXT UNIQUE,
    mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
    -- latest ModelRiver stream channel, so reconnects are limited to this conversation
    last_channel_id TEXT,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );
  `,
  // v2: the name visitors give when they start a chat.
  `ALTER TABLE conversations ADD COLUMN visitor_name TEXT NOT NULL DEFAULT '';`,
  // v3: two-factor sign-in (authenticator app codes + one-time recovery codes).
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  CREATE TABLE recovery_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at TEXT
  );
  -- A sign-in that passed the password step and is waiting for a code
  -- (or for 2FA setup, with the secret being set up in pending_secret).
  CREATE TABLE login_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pending_secret TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
  `,
  // v4: visitors can end a conversation; it stays readable for the team.
  `ALTER TABLE conversations ADD COLUMN ended_at TEXT;`,
  // v5: when the visitor asked for a person; cleared once a team member replies.
  `ALTER TABLE conversations ADD COLUMN handoff_requested_at TEXT;`,
  // v6: conversations the team archived, by ModelRiver session (API sessions
  // have no conversations row). Deleted for good after ARCHIVE_RETENTION_HOURS.
  `
  CREATE TABLE archived_sessions (
    session_id TEXT PRIMARY KEY,
    archived_at TEXT NOT NULL,
    archived_by TEXT
  );
  CREATE INDEX archived_sessions_archived_at ON archived_sessions (archived_at);
  `,
  // v7: whether a sign-in passed the two-factor step (sessions from before
  // this count as not, so everyone signs in once more), and wrong sign-in
  // codes per account, which lock it after LOCK_AFTER_FAILURES.
  `
  ALTER TABLE auth_sessions ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_failures INTEGER NOT NULL DEFAULT 0;
  `,
  // v8: why the chat was handed to the team: 'asked' (the visitor asked for a
  // person) or 'ai_error' (the AI couldn't answer). Read only while
  // handoff_requested_at is set.
  `ALTER TABLE conversations ADD COLUMN handoff_reason TEXT;`,
  // v9: the team member handling the conversation (set by Take over or a
  // reply, cleared by Hand back to AI), so two people don't answer at once.
  `ALTER TABLE conversations ADD COLUMN assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;`,
  // v10: each team member's email notifications: someone waiting for a person
  // (on by default) and every new conversation (off by default).
  `
  ALTER TABLE users ADD COLUMN notify_handoff INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN notify_new_conversations INTEGER NOT NULL DEFAULT 0;
  `,
  // v11: help-center structure and feedback. Articles get a section, an
  // order and the file's modified time (for the sitemap). Visitors vote on
  // articles (one vote per browser per article, which they can change), and
  // questions the help center couldn't answer are kept for the team, without
  // anything that identifies the visitor beyond the conversation they came from.
  `
  ALTER TABLE articles ADD COLUMN category TEXT NOT NULL DEFAULT 'General';
  ALTER TABLE articles ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000;
  ALTER TABLE articles ADD COLUMN modified_at TEXT;
  CREATE TABLE article_feedback (
    slug TEXT NOT NULL,
    voter TEXT NOT NULL,
    helpful INTEGER NOT NULL CHECK (helpful IN (0, 1)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (slug, voter)
  );
  CREATE TABLE knowledge_gaps (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    normalized TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('no_match', 'asked', 'ai_error')),
    session_id TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT
  );
  CREATE INDEX knowledge_gaps_normalized ON knowledge_gaps (normalized, created_at);
  `,
  // v12: the reasons a question counts as unanswered, settled: nothing in the
  // articles matched, the AI said it wasn't sure, or the AI failed. The table
  // had no rows yet, so it is simply recreated.
  `
  DROP TABLE knowledge_gaps;
  CREATE TABLE knowledge_gaps (
    id INTEGER PRIMARY KEY,
    question TEXT NOT NULL,
    normalized TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('no_match', 'unsure', 'ai_error')),
    session_id TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT
  );
  CREATE INDEX knowledge_gaps_normalized ON knowledge_gaps (normalized, created_at);
  `,
  // v13: folders in the data folder are help-center sections; a subfolder is a subsection.
  `ALTER TABLE articles ADD COLUMN subcategory TEXT;`,
  // v14: article URLs include their folders (/help/billing/refunds; /articles/… since).
  `ALTER TABLE articles ADD COLUMN path TEXT;`,
  // v15: the last usage fetched from ModelRiver per month, shown when it can't be reached.
  `
  CREATE TABLE usage_snapshots (
    month TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  `,
  // v16: connectors (Shopify, Stripe, Cal.com, Custom HTTP). Settings and
  // keys entered in Integrations (keys encrypted with DESK_SECRET_KEY), each
  // lookup the AI made (no account data, only who was looked up, masked, and
  // the outcome), changes admins made to connectors, and visitors who proved
  // their email, which lookups require.
  `
  CREATE TABLE connector_settings (
    connector TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    -- {"values": {field: text}, "options": {name: boolean}}; never secrets
    settings TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE connector_secrets (
    connector TEXT NOT NULL,
    field TEXT NOT NULL,
    -- AES-256-GCM, base64; key_id says which DESK_SECRET_KEY encrypted it
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_id TEXT NOT NULL,
    last4 TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (connector, field)
  );
  CREATE TABLE connector_events (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    connector TEXT NOT NULL,
    subject_masked TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'error', 'rate_limited')),
    detail TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX connector_events_created_at ON connector_events (created_at);
  CREATE INDEX connector_events_conversation ON connector_events (conversation_id, created_at);
  CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    user_name TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX admin_audit_created_at ON admin_audit (created_at);
  ALTER TABLE conversations ADD COLUMN verified_email TEXT;
  ALTER TABLE conversations ADD COLUMN verified_at TEXT;
  ALTER TABLE conversations ADD COLUMN verified_via TEXT CHECK (verified_via IN ('email_code', 'identity_token'));
  -- One pending email code per conversation, stored hashed.
  CREATE TABLE visitor_codes (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  `,
  // v17: when the verified visitor last sent a message, so a verification
  // lapses after a while without one (and after VERIFIED_HOURS in any case).
  `ALTER TABLE conversations ADD COLUMN verified_active_at TEXT;`,
  // v18: settings admins change from the dashboard (whether the chat is on).
  `
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
  `,
  // v19: team members' profile pictures, shown beside their replies in the chat.
  // Served by hash (/avatars/<hash>), so the address never names the person.
  `
  CREATE TABLE user_avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    data BLOB NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    updated_at TEXT NOT NULL
  );
  `,
  // v20: messages visitors leave for the team while "Talk with a person" is off.
  // They outlive the chat they came from (its id is cleared when it's deleted).
  `
  CREATE TABLE visitor_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    session_id TEXT,
    visitor_name TEXT NOT NULL,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    handled_at TEXT,
    handled_by TEXT
  );
  CREATE INDEX visitor_messages_open ON visitor_messages (handled_at, created_at);
  `,
  // v21: who's waiting for a person, read by every inbox poll and the sidebar
  // count: an index over just those rows, so it stays instant with a long history.
  `
  CREATE INDEX conversations_waiting ON conversations (handoff_requested_at)
    WHERE handoff_requested_at IS NOT NULL AND ended_at IS NULL;
  `,
  // v22: tickets. A ticket is a request the team answers by email: a message
  // left from the chat, a chat turned into one, or one a team member opens.
  // Its id is the number people see (#12). Everything that happens on it
  // (the customer's message, replies, notes, status and assignee changes) is
  // a ticket_event. Messages left under v20 become tickets; done ones solved.
  // draft_sessions: ModelRiver sessions started by AI drafts, kept out of the
  // inbox until they're deleted (see tickets.server.ts).
  `
  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    session_id TEXT,
    visitor_name TEXT NOT NULL,
    email TEXT,
    email_verified INTEGER NOT NULL DEFAULT 0,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'solved')),
    assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('chat', 'team')),
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    solved_at TEXT,
    legacy_id TEXT
  );
  CREATE INDEX tickets_status ON tickets (status, updated_at);
  CREATE INDEX tickets_assignee ON tickets (assignee_id, status);
  CREATE TABLE ticket_events (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'reply', 'note', 'status', 'assign')),
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT,
    body TEXT NOT NULL DEFAULT '',
    email_status TEXT CHECK (email_status IN ('sent', 'failed')),
    email_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ticket_events_ticket ON ticket_events (ticket_id, id);
  CREATE TABLE draft_sessions (
    session_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  INSERT INTO tickets (conversation_id, session_id, visitor_name, email, email_verified, subject, status, source, created_at, updated_at, solved_at, legacy_id)
    SELECT conversation_id, session_id, visitor_name, email, email_verified,
           substr(trim(replace(replace(text, char(13), ' '), char(10), ' ')), 1, 80),
           CASE WHEN handled_at IS NULL THEN 'open' ELSE 'solved' END, 'chat',
           created_at, coalesce(handled_at, created_at), handled_at, id
    FROM visitor_messages ORDER BY created_at;
  INSERT INTO ticket_events (ticket_id, kind, author_name, body, created_at)
    SELECT t.id, 'message', v.visitor_name, v.text, v.created_at FROM tickets t JOIN visitor_messages v ON v.id = t.legacy_id;
  INSERT INTO ticket_events (ticket_id, kind, author_name, body, created_at)
    SELECT t.id, 'status', v.handled_by, 'solved', v.handled_at FROM tickets t JOIN visitor_messages v ON v.id = t.legacy_id
    WHERE v.handled_at IS NOT NULL;
  ALTER TABLE tickets DROP COLUMN legacy_id;
  DROP TABLE visitor_messages;
  `,
  // v23: each ticket's reference is a short random code (#K7F3Q9), not its
  // row number, so customers can't tell how many tickets there are. Codes use
  // only characters that can't be misread (see ticket-core.ts).
  `
  ALTER TABLE tickets ADD COLUMN ref TEXT;
  UPDATE tickets SET ref = substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1) || substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1) || substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1) || substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1) || substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1) || substr('ABCDEFGHJKMNPQRSTVWXYZ23456789', (abs(random()) % 30) + 1, 1);
  CREATE UNIQUE INDEX tickets_ref ON tickets (ref);
  `,
  // v24: customers viewing their ticket (/tickets/<ref>). ticket_links: the
  // private key in each reply email, which signs them in for that ticket.
  // customer_codes: 6-digit codes for opening a ticket without the link.
  // customer_sessions: a signed-in customer's email, behind an HttpOnly cookie.
  // Keys, codes and session tokens are stored hashed.
  `
  CREATE TABLE ticket_links (
    token_hash TEXT PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX ticket_links_expires ON ticket_links (expires_at);
  CREATE TABLE customer_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT
  );
  CREATE TABLE customer_sessions (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX customer_sessions_expires ON customer_sessions (expires_at);
  `,
  // v25: the customer portal. blocked_customers: addresses the team blocked
  // (no codes, sign-ins, links, tickets or replies). tickets.origin: where a
  // ticket came from, which can now also be the portal (source keeps its
  // original two values, as SQLite can't widen its check in place).
  `
  CREATE TABLE blocked_customers (
    email TEXT PRIMARY KEY,
    blocked_at TEXT NOT NULL,
    blocked_by TEXT,
    reason TEXT
  );
  ALTER TABLE tickets ADD COLUMN origin TEXT;
  UPDATE tickets SET origin = source;
  CREATE INDEX tickets_email ON tickets (email, updated_at);
  `,
  // v26: emails that failed to send, retried with a growing wait (see
  // outbox.server.ts); a ticket reply's row says which reply it is and the
  // status to set once it's sent. And ticket notifications, split from
  // "someone wants a person": every new ticket (on for whoever had that on),
  // and activity on tickets assigned to you (on for everyone).
  `
  CREATE TABLE email_outbox (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    ticket_event_id INTEGER REFERENCES ticket_events(id) ON DELETE CASCADE,
    then_status TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at);
  ALTER TABLE users ADD COLUMN notify_new_tickets INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN notify_my_tickets INTEGER NOT NULL DEFAULT 1;
  UPDATE users SET notify_new_tickets = notify_handoff;
  `,
  // v27: the subjects customers pick from when they raise a ticket, set up
  // under Tickets → Subjects, in the order they're shown.
  `
  CREATE TABLE ticket_subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
]

let db: DatabaseSync | undefined

export function getDb(): DatabaseSync {
  if (db) return db
  db = openDb(env.databasePath)
  return db
}

export function openDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const conn = new DatabaseSync(file)
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  migrate(conn)
  return conn
}

export function migrate(conn: DatabaseSync) {
  const row = conn.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    conn.exec('BEGIN')
    try {
      conn.exec(MIGRATIONS[v]!)
      conn.exec(`PRAGMA user_version = ${v + 1}`)
      conn.exec('COMMIT')
    } catch (err) {
      conn.exec('ROLLBACK')
      throw err
    }
  }
}

export function now(): string {
  return new Date().toISOString()
}
