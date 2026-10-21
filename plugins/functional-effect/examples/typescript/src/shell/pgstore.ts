// The Store capability on PostgreSQL, with the SQL of
// skills/model/references/outbox.md (contract.test.ts checks the two match).
//
// It needs only a minimal SQL client, so node-postgres and PGlite both fit
// behind a few lines of adapter. Database errors are defects here (Effect.die),
// because the Store service has no error channel for them; a production store
// would add a StoreUnavailable error and classify it as retry.

import { Effect } from "effect"
import { type Command, type Input, type OrderId, type State, initial } from "../core/order.js"
import { type OutboxItem, Conflict, Duplicate, Store } from "./store.js"

type Rows = { readonly rows: ReadonlyArray<Record<string, unknown>> }

export interface SqlClient {
  readonly query: (text: string, params?: unknown[]) => Promise<Rows>
}

/** A client that can run a function in one transaction; throwing rolls it back. */
export interface Sql extends SqlClient {
  readonly transaction: <T>(f: (tx: SqlClient) => Promise<T>) => Promise<T>
}

export const sql = {
  schema: `
create table orders (
  id      text   primary key,
  state   jsonb  not null,
  version bigint not null
);
create table inbox (
  event_id     text        primary key,
  order_id     text        not null,
  processed_at timestamptz not null default now()
);
create table order_events (
  order_id text   not null,
  seq      bigint not null,
  event_id text   not null unique,
  input    jsonb  not null,
  primary key (order_id, seq)
);
create table outbox (
  id            text        primary key,
  seq           bigserial,
  order_id      text        not null,
  command       jsonb       not null,
  due_at        timestamptz not null,
  claimed_until timestamptz
);
create index outbox_due on outbox (due_at);`,
  commit_inbox: `
insert into inbox (event_id, order_id) values ($1, $2)
on conflict (event_id) do nothing
returning event_id;`,
  commit_state: `
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
select version from created;`,
  commit_event: `
insert into order_events (order_id, seq, event_id, input) values ($1, $2, $3, $4);`,
  commit_outbox: `
insert into outbox (id, order_id, command, due_at) values ($1, $2, $3, $4)
on conflict (id) do nothing;`,
  claim_due: `
update outbox set claimed_until = $1::timestamptz + $2::interval
where id in (
  select id from outbox
  where due_at <= $1 and (claimed_until is null or claimed_until <= $1)
  order by due_at, seq
  limit $3
  for update skip locked
)
returning id, seq, order_id, command, due_at;`,
  complete: `
delete from outbox where id = $1;`,
  release: `
update outbox set due_at = $2, claimed_until = null where id = $1;`,
  replay: `
select input from order_events where order_id = $1 order by seq;`,
} as const

class Rollback {
  constructor(readonly reason: "Duplicate" | "Conflict") {}
}

const iso = (ms: number) => new Date(ms).toISOString()
const millis = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)))

// The store trusts its own rows: they were written by commit from core values.
// Decoding them with a Schema would add a check against manual edits.
export const pgStore = (db: Sql, options: { readonly leaseMs: number }): Store["Service"] => {
  const query = (text: string, params: unknown[]) => Effect.promise(() => db.query(text, params))
  return {
    load: (id) =>
      query("select state, version from orders where id = $1", [id]).pipe(
        Effect.map(({ rows }) => {
          const row = rows[0]
          return row ? { state: row.state as State, version: Number(row.version) } : { state: initial, version: 0 }
        }),
      ),
    commit: (c) =>
      Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            if ((await tx.query(sql.commit_inbox, [c.eventId, c.orderId])).rows.length === 0) throw new Rollback("Duplicate")
            const v = await tx.query(sql.commit_state, [c.orderId, c.expected, c.state])
            if (v.rows.length === 0) throw new Rollback("Conflict")
            await tx.query(sql.commit_event, [c.orderId, Number(v.rows[0]!.version), c.eventId, c.input])
            for (const o of c.outbox) await tx.query(sql.commit_outbox, [o.id, c.orderId, o.command, iso(o.dueAt)])
          }),
        catch: (e) => e,
      }).pipe(
        Effect.catch((e): Effect.Effect<never, Conflict | Duplicate> => {
          if (e instanceof Rollback)
            return Effect.fail(e.reason === "Duplicate" ? new Duplicate({ eventId: c.eventId }) : new Conflict({ orderId: c.orderId }))
          return Effect.die(e)
        }),
      ),
    claimDue: (now, limit) =>
      query(sql.claim_due, [iso(now), `${options.leaseMs} milliseconds`, limit]).pipe(
        Effect.map(({ rows }) =>
          [...rows]
            // RETURNING does not keep the subquery's order.
            .sort((a, b) => millis(a.due_at) - millis(b.due_at) || Number(a.seq) - Number(b.seq))
            .map((r): OutboxItem => ({ id: String(r.id), orderId: r.order_id as OrderId, command: r.command as Command, dueAt: millis(r.due_at) })),
        ),
      ),
    complete: (itemId) => query(sql.complete, [itemId]).pipe(Effect.asVoid),
    release: (itemId, retryAt) => query(sql.release, [itemId, iso(retryAt)]).pipe(Effect.asVoid),
    events: (id) => query(sql.replay, [id]).pipe(Effect.map(({ rows }) => rows.map((r) => r.input as Input))),
  }
}
