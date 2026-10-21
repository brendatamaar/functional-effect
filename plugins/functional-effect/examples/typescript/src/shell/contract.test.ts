// Contract runs: each capability's contract suite against every implementation.
// The fakes used by shell.test.ts are only trustworthy because they pass here.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import type { Amount } from "../core/order.js"
import { paymentGatewayContract } from "./contract/gateway.js"
import { storeContract } from "./contract/store.js"
import { FakeGateway } from "./fakes.js"
import { startGatewaySim } from "./gatewaysim.js"
import { httpGateway } from "./httpgateway.js"
import { type Sql, pgStore, sql } from "./pgstore.js"
import { MemoryStore } from "./store.js"
import type { Behavior } from "./fakes.js"

const declineAmount = 402 as Amount

paymentGatewayContract("FakeGateway", () => {
  const next = new Map<string, Behavior>()
  const fake = new FakeGateway((op) => {
    const b = next.get(op) ?? "Normal"
    next.delete(op)
    return b
  })
  fake.declineAmount = declineAmount
  return {
    gateway: fake.service,
    declineAmount,
    inject: (op, fault) => void next.set(op, fault === "Unreachable" ? "Transient" : "LostResponse"),
    charged: (id) => fake.chargedFor(id),
  }
})

paymentGatewayContract("httpGateway against the simulator", async () => {
  const sim = await startGatewaySim(declineAmount)
  return {
    gateway: httpGateway({ baseUrl: sim.url, timeoutMs: 5000 }),
    declineAmount,
    inject: (op, fault) => (fault === "Unreachable" ? sim.failNext(op) : sim.loseNext(op)),
    charged: (id) => sim.charged(id),
    close: () => sim.close(),
  }
})

// The only run that checks our reading of the provider:
//   PAYMENTS_SANDBOX_URL=… PAYMENTS_SANDBOX_KEY=… PAYMENTS_SANDBOX_DECLINE_AMOUNT=402 npm test
const sandbox = process.env.PAYMENTS_SANDBOX_URL
if (sandbox) {
  paymentGatewayContract("httpGateway against the sandbox", () => ({
    gateway: httpGateway({ baseUrl: sandbox, apiKey: process.env.PAYMENTS_SANDBOX_KEY ?? "", timeoutMs: 15_000 }),
    declineAmount: Number(process.env.PAYMENTS_SANDBOX_DECLINE_AMOUNT) as Amount,
    // No inject, no charged: a sandbox cannot be told to fail, and money
    // movements are observed through resolve only.
  }))
} else {
  test("httpGateway against the sandbox", { skip: "PAYMENTS_SANDBOX_URL not set" }, () => {})
}

storeContract("MemoryStore", () => ({ store: new MemoryStore(30_000).service, leaseMs: 30_000 }))

/** PGlite behind the two-method Sql interface pgStore needs. */
const pglite = async (): Promise<{ db: Sql; close: () => Promise<void> }> => {
  const pg = new PGlite()
  await pg.exec(sql.schema)
  return {
    db: {
      query: (text, params) => pg.query(text, params),
      transaction: (f) => pg.transaction((tx) => f({ query: (text, params) => tx.query(text, params) })),
    },
    close: () => pg.close(),
  }
}

storeContract("PgStore on PostgreSQL (PGlite)", async () => {
  const { db, close } = await pglite()
  return { store: pgStore(db, { leaseMs: 30_000 }), leaseMs: 30_000, close }
})

// The SQL reference is executable documentation: PgStore runs exactly its blocks.
const reference = fileURLToPath(new URL("../../../../skills/model/references/outbox.md", import.meta.url))
test("PgStore uses the SQL of references/outbox.md", { skip: existsSync(reference) ? false : "reference not found" }, () => {
  const doc = readFileSync(reference, "utf8")
  const normalize = (s: string) => s.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim()
  const blocks = [...doc.matchAll(/```sql\n-- name: (\w+)\n([\s\S]*?)```/g)]
  assert.equal(blocks.length, Object.keys(sql).length, "one SQL block per statement")
  for (const [, name, body] of blocks) {
    assert.equal(normalize(sql[name as keyof typeof sql] ?? ""), normalize(body!), `block ${name}`)
  }
})
