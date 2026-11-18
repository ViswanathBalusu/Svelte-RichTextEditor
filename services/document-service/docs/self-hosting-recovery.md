# Recovery in a self-hosted deployment

This section of the self-hosting guide says what your recovery point and your recovery time depend
on. It applies to a deployment that you run yourself, with your own PostgreSQL and your own
S3-compatible object store (06 §9, self-hosted row; BE-083).

## What decides your recovery point and time

- **Recovery point.** This is whatever your PostgreSQL provides. The service stores each commit in
  the log in PostgreSQL and acknowledges it only after it is stored. What you lose after a failure
  is therefore what your database setup lost. The service does not add a copy of its own.
- **Recovery time.** This is yours. It depends on how fast you can bring PostgreSQL and the object
  store back, and on how long the checks in the restore procedure take on your data.

## Getting a recovery point of zero for one failure

A recovery point of zero for the loss of one database node needs synchronous replication on your
PostgreSQL: a standby that must confirm each log write before the primary acknowledges it. Set the
standby in your PostgreSQL configuration (`synchronous_standby_names`, with
`synchronous_commit` on) and test a failover of your own. Without it, a failure can lose the
commits that the primary acknowledged but the standby did not yet receive.

## Restore procedure

1. Restore PostgreSQL to the point you choose. Restore the object store (checkpoints and segments)
   from the same time, or as near to it as your backups allow.
2. Find the documents that reach past the restored head. Run the incarnation command in dry-run
   mode. It lists them and changes nothing:

   ```
   node services/document-service/src/data-plane/recovery-cli.ts incarnation --dry-run
   ```

3. Reconcile the object store from the log. Run the same command without `--dry-run`. It gives each
   listed document a new incarnation, records an audit event for it, and sets the checkpoints beyond the restored head aside (in the index and, where the object store supports it, in the store itself) so that they are not used. Clients that reconnect with
   an old incarnation or with a sequence number above the head reload the document (`catchUp`
   `reload`). Documents that were not affected keep their incarnations.
4. Verify the documents you care about with the verification tool. It runs without the service:

   ```
   node services/document-service/src/data-plane/recovery-cli.ts verify --tenant <tenant> --doc <document>
   ```

   It checks the hash chain, each payload against its hash, and each recorded checkpoint against a
   replay of the log. It exits with status 1 and names the first broken `seq` when it finds a
   fault. To print the hash of a document at a given sequence number, use `rebuild` with `--seq`.

Run the tools as the schema owner (an operator role). The `incarnation` command reads across
tenants. Settings come from the environment as for the service (`DOCEDIT_DATABASE_URL` and the
`DOCEDIT_S3_*` settings).

## Rehearse it

Restore into an empty environment at least once before you need it, run the steps above, and time
them. The service's own rehearsal (BE-082) is a hosted-service practice; for your deployment the
time you measure is your recovery time.
