# Persistence, delivery and time in SQL (PostgreSQL)

The in-memory stores in `examples/` (`MemStore` in Go, `MemoryStore` in TypeScript) have exactly these semantics. Each SQL block below is named (`-- name:`); the plugin's test suite runs these blocks against PostgreSQL (PGlite) to check them.

State, inputs and commands are stored as JSON. Encoding the core's sum types to JSON (and decoding them back) belongs to the shell; the core never sees it.

## Schema

```sql
-- name: schema
create table orders (
  id      text   primary key,
  state   jsonb  not null,
  version bigint not null
);

-- Inbox: one row per processed delivery. A redelivered event finds its row and is a no-op.
create table inbox (
  event_id     text        primary key,
  order_id     text        not null,
  processed_at timestamptz not null default now()
);

-- Event log: replaying `input` in `seq` order through run() rebuilds `orders.state`.
create table order_events (
  order_id text   not null,
  seq      bigint not null,
  event_id text   not null unique,
  input    jsonb  not null,
  primary key (order_id, seq)
);

-- Outbox: commands waiting to be interpreted. ScheduleInput rows are timers (due_at in the future).
create table outbox (
  id            text        primary key,  -- '<eventId>#<index>': deterministic
  seq           bigserial,
  order_id      text        not null,
  command       jsonb       not null,
  due_at        timestamptz not null,
  claimed_until timestamptz
);
create index outbox_due on outbox (due_at);
```

## Commit: one transaction per handled input

Run these in one transaction, in this order. Each block lists its own parameters.

```sql
-- name: commit_inbox
-- $1 event ID, $2 order ID.
-- 0 rows: duplicate delivery. Roll back and return the current state.
insert into inbox (event_id, order_id) values ($1, $2)
on conflict (event_id) do nothing
returning event_id;
```

```sql
-- name: commit_state
-- $1 order ID, $2 expected version, $3 new state. Returns the new version.
-- 0 rows: version conflict (someone committed first, or the order is not at $2).
-- Roll back, reload, re-run step. $2 = 0 creates the order; any other value
-- updates it only at exactly that version, so a write against a version that
-- does not exist never creates a row.
with updated as (
  update orders set state = $3, version = version + 1
  where id = $1 and version = $2
  returning version
), created as (
  insert into orders (id, state, version)
  select $1, $3, 1 where $2 = 0
  on conflict (id) do nothing
  returning version
)
select version from updated
union all
select version from created;
```

```sql
-- name: commit_event
-- $1 order ID, $2 the version returned by commit_state, $3 event ID, $4 input.
insert into order_events (order_id, seq, event_id, input) values ($1, $2, $3, $4);
```

```sql
-- name: commit_outbox
-- One row per command. $1 '<eventId>#<index>', $2 order ID, $3 command, $4 due_at
-- (now for ordinary commands, now + after for ScheduleInput).
insert into outbox (id, order_id, command, due_at) values ($1, $2, $3, $4)
on conflict (id) do nothing;
```

## Worker

```sql
-- name: claim_due
-- $1 now, $2 lease (an interval such as '30 seconds'), $3 limit.
-- Lease up to $3 due rows. A row whose worker died becomes due again when the lease expires.
-- SKIP LOCKED lets several workers claim in parallel without taking the same rows.
-- RETURNING does not keep the subquery's order: sort the result by (due_at, seq).
update outbox set claimed_until = $1::timestamptz + $2::interval
where id in (
  select id from outbox
  where due_at <= $1 and (claimed_until is null or claimed_until <= $1)
  order by due_at, seq
  limit $3
  for update skip locked
)
returning id, seq, order_id, command, due_at;
```

```sql
-- name: complete
-- $1 outbox ID.
delete from outbox where id = $1;
```

```sql
-- name: release
-- $1 outbox ID, $2 retry at. RetryLater: try again later.
update outbox set due_at = $2, claimed_until = null where id = $1;
```

## Replay

```sql
-- name: replay
-- $1 order ID.
select input from order_events where order_id = $1 order by seq;
```

## Notes

- Interpret commands **outside** the commit transaction. Never hold a database transaction open across a network call.
- The result of a command is committed with event ID `<outboxId>:result`, so a redelivered command's result is dropped by the inbox.
- Keep inbox rows at least as long as the longest redelivery window of every producer (webhooks are often retried for days).
- A message broker in place of the outbox table is fine as long as publishing happens from the outbox (a relay process reads committed rows), never directly from the request handler.
