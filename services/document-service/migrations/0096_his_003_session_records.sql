-- phase: expand
-- rollback: roll the service back first, then drop table doc_sessions. A service of this release
--   does not open a channel while the table is missing; no earlier release reads or writes it.
--
-- Session records (HIS-003 criterion 3; 08 section 2, last paragraph; owner decision 24 in
-- docs/owner-decisions-2026-11-15.md). One row per session and document: the user as the tenant's
-- surrogate, the user agent family with its major version, and the client version of `hello`.
--
-- The control plane writes the row when a session opens a channel on the document, before the
-- channel is open, so every commit's session has its record. The row is kept as long as the
-- document's history: only the purge of a deleted document removes it (HIS-039), under the purge
-- role. The service role may read and insert, never update or delete.
--
-- No other personal data is stored. The check constraints make the database hold that line, not
-- only the code: the family is one of a closed list, the major version is a number, and the client
-- version must be shaped like a version, so no free text from a `User-Agent` header or from a
-- `hello` can be written here. There is no column for an address, an origin, a host identifier, a
-- name or a time.

create table doc_sessions (
  doc_id uuid not null references documents (id),
  tenant_id uuid not null,
  -- As doc_commits.session_id: the room's sessions are strings (0002).
  session_id text not null check (char_length(session_id) between 1 and 128),
  -- The per-tenant surrogate of the session's user (08 section 13), in the form tenant_users holds.
  user_id text not null check (user_id ~ '^[A-Za-z0-9_.@:+-]{1,128}$'),
  ua_family text not null
    check (ua_family in ('chrome', 'edge', 'firefox', 'safari', 'opera', 'samsung', 'other')),
  ua_major int check (ua_major between 0 and 9999),
  client_version text check (
    char_length(client_version) <= 64
    and client_version ~ '^[0-9]{1,6}(\.[0-9]{1,6}){0,3}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'
  ),
  primary key (doc_id, session_id)
);

select docedit_protect('doc_sessions');

grant select, insert on doc_sessions to docedit_app;

-- The purge of a deleted document removes its session records with the rest (0073).
grant select, delete on doc_sessions to docedit_purge;
