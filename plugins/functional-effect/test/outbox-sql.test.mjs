// Runs the named SQL blocks in skills/model/references/outbox.md against
// PostgreSQL (PGlite, Postgres compiled to WASM) and checks their semantics:
// inbox de-duplication, optimistic concurrency, outbox claim with leases.
//
// Optional: `cd test && npm install` first. Skipped when PGlite is not installed.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const doc = readFileSync(path.join(here, "..", "skills", "model", "references", "outbox.md"), "utf8")

const blocks = Object.fromEntries(
  [...doc.matchAll(/```sql\n-- name: (\w+)\n([\s\S]*?)```/g)].map(([, name, body]) => [name, body.trim()]),
)

let PGlite
try {
  ;({ PGlite } = await import("@electric-sql/pglite"))
} catch {
  PGlite = null
}

const skip = PGlite ? false : "PGlite not installed (cd test && npm install)"

test("every documented block is named and present", () => {
  for (const name of ["schema", "commit_inbox", "commit_state", "commit_event", "commit_outbox", "claim_due", "complete", "release", "replay"])
    assert.ok(blocks[name], `missing SQL block ${name}`)
})

/** The commit transaction exactly as documented: returns "ok", "duplicate" or "conflict". */
const commit = async (db, { orderId, expected, eventId, input, state, outbox }) =>
  db.transaction(async (tx) => {
    if ((await tx.query(blocks.commit_inbox, [eventId, orderId])).rows.length === 0) {
      await tx.rollback()
      return "duplicate"
    }
    const v = await tx.query(blocks.commit_state, [orderId, expected, state])
    if (v.rows.length === 0) {
      await tx.rollback()
      return "conflict"
    }
    const version = Number(v.rows[0].version)
    await tx.query(blocks.commit_event, [orderId, version, eventId, input])
    for (const o of outbox) await tx.query(blocks.commit_outbox, [o.id, orderId, o.command, o.dueAt])
    return "ok"
  })

test("commit: inbox, optimistic concurrency, event log and outbox", { skip }, async () => {
  const db = new PGlite()
  await db.exec(blocks.schema)
  const t0 = "2026-01-01T09:00:00Z"
  const t10 = "2026-01-01T09:10:00Z"
  const submit = { tag: "Submit", orderId: "ord-1", amount: 4200 }

  assert.equal(
    await commit(db, {
      orderId: "ord-1", expected: 0, eventId: "evt-1", input: submit,
      state: { tag: "AwaitingPayment", attempt: 1 },
      outbox: [
        { id: "evt-1#0", command: { tag: "ChargeCard" }, dueAt: t0 },
        { id: "evt-1#1", command: { tag: "ScheduleInput" }, dueAt: t10 },
      ],
    }),
    "ok",
  )
  // the same delivery again: no-op
  assert.equal(await commit(db, { orderId: "ord-1", expected: 1, eventId: "evt-1", input: submit, state: {}, outbox: [] }), "duplicate")
  // a writer ahead of the stored version never creates a row
  assert.equal(await commit(db, { orderId: "ord-2", expected: 1, eventId: "evt-x", input: submit, state: {}, outbox: [] }), "conflict")
  assert.equal((await db.query("select count(*)::int as n from orders where id = 'ord-2'")).rows[0].n, 0)
  // a stale writer (expected 0, or a second "new order")
  assert.equal(await commit(db, { orderId: "ord-1", expected: 0, eventId: "evt-2", input: submit, state: {}, outbox: [] }), "conflict")
  // the conflict rolled back its inbox row, so the retry with the right version succeeds
  assert.equal(
    await commit(db, { orderId: "ord-1", expected: 1, eventId: "evt-2", input: { tag: "PaymentSucceeded" }, state: { tag: "Paid" }, outbox: [] }),
    "ok",
  )

  const order = (await db.query("select state, version from orders where id = 'ord-1'")).rows[0]
  assert.deepEqual(order.state, { tag: "Paid" })
  assert.equal(Number(order.version), 2)
  const replay = (await db.query(blocks.replay, ["ord-1"])).rows.map((r) => r.input.tag)
  assert.deepEqual(replay, ["Submit", "PaymentSucceeded"])

  // worker: only the due row is claimed; a claimed row is leased
  const claim = async (now) => (await db.query(blocks.claim_due, [now, "30 seconds", 10])).rows.map((r) => r.id)
  assert.deepEqual(await claim(t0), ["evt-1#0"])
  assert.deepEqual(await claim(t0), [], "leased: not claimed twice")
  assert.deepEqual(await claim("2026-01-01T09:00:31Z"), ["evt-1#0"], "lease expired: redelivered")
  await db.query(blocks.release, ["evt-1#0", "2026-01-01T09:05:00Z"])
  assert.deepEqual(await claim("2026-01-01T09:01:00Z"), [], "released to a later time")
  await db.query(blocks.complete, ["evt-1#0"])
  assert.deepEqual(await claim(t10), ["evt-1#1"], "the timer row is due at +10m")
  await db.close()
})
