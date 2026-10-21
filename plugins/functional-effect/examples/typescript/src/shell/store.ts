// Store: each order's state saved together with its commands, atomically.
//
// commit is the heart of it. In one transaction it checks the expected version
// (optimistic concurrency), records the event ID (inbox: at-least-once delivery
// becomes exactly-once processing), appends the input to the event log, saves
// the new state and inserts the commands into the outbox. A crash can never
// lose a command whose state was saved, nor save a state whose commands were
// lost. See skills/model/references/outbox.md for the SQL version.

import { Context, Data, Effect } from "effect"
import { type Command, type Input, type OrderId, type State, initial } from "../core/order.js"

export class Conflict extends Data.TaggedError("Conflict")<{ readonly orderId: OrderId }> {}
export class Duplicate extends Data.TaggedError("Duplicate")<{ readonly eventId: string }> {}

export interface OutboxItem {
  readonly id: string
  readonly orderId: OrderId
  readonly command: Command
  readonly dueAt: number
}

export interface Commit {
  readonly orderId: OrderId
  readonly expected: number
  readonly eventId: string
  readonly input: Input
  readonly state: State
  readonly outbox: readonly OutboxItem[]
}

export class Store extends Context.Service<
  Store,
  {
    readonly load: (id: OrderId) => Effect.Effect<{ readonly state: State; readonly version: number }>
    readonly commit: (c: Commit) => Effect.Effect<void, Conflict | Duplicate>
    /** Lease up to `limit` due items; an item never completed becomes due again when its lease expires. */
    readonly claimDue: (now: number, limit: number) => Effect.Effect<readonly OutboxItem[]>
    readonly complete: (itemId: string) => Effect.Effect<void>
    readonly release: (itemId: string, retryAt: number) => Effect.Effect<void>
    readonly events: (id: OrderId) => Effect.Effect<readonly Input[]>
  }
>()("Store") {}

interface Row {
  state: State
  version: number
  events: Input[]
}

interface OutboxRow {
  item: OutboxItem
  seq: number
  claimedUntil: number
}

/**
 * In-memory Store with the same transactional semantics as the SQL version.
 * `load` reads, then yields to other fibers before returning, like a real database
 * round trip, so concurrent handlers see stale reads and the version check is exercised.
 */
export class MemoryStore {
  private readonly orders = new Map<OrderId, Row>()
  private readonly inbox = new Set<string>()
  private readonly outbox = new Map<string, OutboxRow>()
  private seq = 0

  constructor(private leaseMs = 30_000) {}

  readonly service: Store["Service"] = {
    // Read now, return later: other fibers can commit in between, like a real round trip.
    load: (id) =>
      Effect.sync(() => {
        const row = this.orders.get(id)
        return row ? { state: row.state, version: row.version } : { state: initial, version: 0 }
      }).pipe(Effect.tap(() => Effect.yieldNow)),
    commit: (c) =>
      Effect.suspend((): Effect.Effect<void, Conflict | Duplicate> => {
        if (this.inbox.has(c.eventId)) return Effect.fail(new Duplicate({ eventId: c.eventId }))
        const row = this.orders.get(c.orderId) ?? { state: initial, version: 0, events: [] }
        if (row.version !== c.expected) return Effect.fail(new Conflict({ orderId: c.orderId }))
        this.inbox.add(c.eventId)
        this.orders.set(c.orderId, { state: c.state, version: row.version + 1, events: [...row.events, c.input] })
        for (const item of c.outbox) this.outbox.set(item.id, { item, seq: ++this.seq, claimedUntil: 0 })
        return Effect.void
      }),
    claimDue: (now, limit) =>
      Effect.sync(() => {
        const due = [...this.outbox.values()]
          .filter((r) => r.item.dueAt <= now && r.claimedUntil <= now)
          .sort((a, b) => a.item.dueAt - b.item.dueAt || a.seq - b.seq)
          .slice(0, limit)
        for (const r of due) r.claimedUntil = now + this.leaseMs
        return due.map((r) => r.item)
      }),
    complete: (itemId) => Effect.sync(() => void this.outbox.delete(itemId)),
    release: (itemId, retryAt) =>
      Effect.sync(() => {
        const r = this.outbox.get(itemId)
        if (r) this.outbox.set(itemId, { ...r, item: { ...r.item, dueAt: retryAt }, claimedUntil: 0 })
      }),
    events: (id) => Effect.sync(() => [...(this.orders.get(id)?.events ?? [])]),
  }

  /** Outbox items, in insertion order (tests). */
  peek(): readonly OutboxItem[] {
    return [...this.outbox.values()].sort((a, b) => a.seq - b.seq).map((r) => r.item)
  }

  /** Waiting outbox items (tests and demos). */
  pending(): number {
    return this.outbox.size
  }

  /** Earliest time an outbox item becomes claimable, if any. */
  nextDue(): number | undefined {
    let next: number | undefined
    for (const r of this.outbox.values()) {
      const at = Math.max(r.item.dueAt, r.claimedUntil)
      if (next === undefined || at < next) next = at
    }
    return next
  }

  /** Simulate a very long stall (tests). */
  setLease(ms: number): void {
    this.leaseMs = ms
  }
}
