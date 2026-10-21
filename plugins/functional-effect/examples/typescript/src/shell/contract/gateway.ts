// Contract suites: the behavior every implementation of a capability must
// have, written once and run against each implementation.
//
// A fake is only worth testing against if it behaves like the real thing. Run
// each suite against the fake (every test run) and against the live adapter
// (against a simulator every run, and against the provider's sandbox or a real
// database when configured). If both pass the same suite, a shell test that
// passes with the fake says something about production.
//
// Clauses use only the capability's interface plus the optional hooks in the
// subject, never an implementation's internals, so they can run against a
// service we do not control.

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { type Amount, type OrderId, chargeKey } from "../../core/order.js"
import type { PaymentDeclined, PaymentGateway, PaymentStatus, Transient } from "../capabilities.js"

/** A failure a test can inject into the next call. */
export type Fault = "Unreachable" | "LostResponse"

export interface GatewayUnderTest {
  readonly gateway: PaymentGateway["Service"]
  /** An amount the implementation always declines (sandboxes document magic values). */
  readonly declineAmount: Amount
  /** Make the next call to op fail. Absent when faults cannot be injected (a real sandbox): those clauses skip. */
  readonly inject?: (op: "charge" | "resolve", fault: Fault) => void
  /** How many times money moved for an order. Absent when unobservable: those checks are skipped. */
  readonly charged?: (orderId: OrderId) => number
  readonly close?: () => Promise<void>
}

type Outcome<A> = { readonly tag: "ok"; readonly value: A } | { readonly tag: "PaymentDeclined" | "Transient" }

/** Run a call; an error outside the capability's error channel (a defect) fails the clause. */
const outcome = async <A>(op: string, eff: Effect.Effect<A, PaymentDeclined | Transient>): Promise<Outcome<A>> => {
  try {
    const r = await Effect.runPromise(Effect.result(eff))
    return r._tag === "Success" ? { tag: "ok", value: r.success } : { tag: r.failure._tag }
  } catch (e) {
    return assert.fail(`${op}: unclassified error (a defect; must be PaymentDeclined or Transient): ${String(e)}`)
  }
}

const amount = 4200 as Amount

export const paymentGatewayContract = (suite: string, make: () => GatewayUnderTest | Promise<GatewayUnderTest>) =>
  describe(suite, () => {
    const run = `ct-${randomUUID().slice(0, 8)}`

    interface Env extends GatewayUnderTest {
      readonly order: OrderId
      readonly charge: (key: string, amount: Amount) => Promise<Outcome<void>["tag"]>
      readonly resolve: (key: string) => Promise<PaymentStatus>
      readonly wantCharged: (n: number) => void
    }

    const clause = (name: string, needsFaults: boolean, body: (e: Env) => Promise<void>) =>
      it(name, async (t) => {
        const g = await make()
        try {
          if (needsFaults && !g.inject) return t.skip("implementation cannot inject faults")
          const order = `${run}-${name.replace(/\W+/g, "-")}` as OrderId
          await body({
            ...g,
            order,
            charge: async (key, amt) => (await outcome("charge", g.gateway.charge(key as never, order, amt))).tag,
            resolve: async (key) => {
              const r = await outcome("resolve", g.gateway.resolve(key as never))
              if (r.tag !== "ok") return assert.fail(`resolve ${key}: ${r.tag}`)
              return r.value
            },
            wantCharged: (n) => {
              if (g.charged) assert.equal(g.charged(order), n, `money moved ${g.charged(order)} times, want ${n}`)
            },
          })
        } finally {
          await g.close?.()
        }
      })

    clause("a charge is reported by resolve", false, async (e) => {
      const key = chargeKey(e.order, 1)
      assert.equal(await e.charge(key, amount), "ok")
      assert.equal(await e.resolve(key), "Charged")
      e.wantCharged(1)
    })

    clause("charge is idempotent per key", false, async (e) => {
      const key = chargeKey(e.order, 1)
      for (let i = 0; i < 3; i++) assert.equal(await e.charge(key, amount), "ok", `charge #${i + 1}`)
      e.wantCharged(1)
    })

    clause("a decline is a domain outcome and is stable", false, async (e) => {
      const key = chargeKey(e.order, 1)
      assert.equal(await e.charge(key, e.declineAmount), "PaymentDeclined")
      assert.equal(await e.charge(key, e.declineAmount), "PaymentDeclined")
      assert.equal(await e.resolve(key), "Declined")
      e.wantCharged(0)
    })

    clause("resolve fences a key it has never seen", false, async (e) => {
      const key = chargeKey(e.order, 1)
      assert.equal(await e.resolve(key), "NotFound")
      assert.equal(await e.charge(key, amount), "PaymentDeclined", "a charge after the fence must be declined")
      assert.ok(["NotFound", "Declined"].includes(await e.resolve(key)))
      e.wantCharged(0)
    })

    clause("keys are independent", false, async (e) => {
      const k1 = chargeKey(e.order, 1)
      const k2 = chargeKey(e.order, 2)
      assert.equal(await e.charge(k1, amount), "ok")
      assert.equal(await e.resolve(k2), "NotFound")
      assert.equal(await e.resolve(k1), "Charged")
      e.wantCharged(1)
    })

    clause("an unreachable charge has no effect and can be retried", true, async (e) => {
      const key = chargeKey(e.order, 1)
      e.inject!("charge", "Unreachable")
      assert.equal(await e.charge(key, amount), "Transient")
      e.wantCharged(0)
      assert.equal(await e.charge(key, amount), "ok")
      e.wantCharged(1)
    })

    clause("a lost response is not a failure: the retry does not charge twice", true, async (e) => {
      const key = chargeKey(e.order, 1)
      e.inject!("charge", "LostResponse")
      // A client may retry an idempotent request on its own, so success is also correct.
      assert.ok(["ok", "Transient"].includes(await e.charge(key, amount)))
      assert.equal(await e.charge(key, amount), "ok")
      e.wantCharged(1)
    })

    clause("resolve after a lost response finds the charge", true, async (e) => {
      const key = chargeKey(e.order, 1)
      e.inject!("charge", "LostResponse")
      await e.charge(key, amount)
      assert.equal(await e.resolve(key), "Charged")
      e.wantCharged(1)
    })

    clause("an unreachable resolve does not fence the key", true, async (e) => {
      const key = chargeKey(e.order, 1)
      e.inject!("resolve", "Unreachable")
      assert.equal((await outcome("resolve", e.gateway.resolve(key))).tag, "Transient")
      assert.equal(await e.charge(key, amount), "ok", "the key must still be usable")
      e.wantCharged(1)
    })
  })
