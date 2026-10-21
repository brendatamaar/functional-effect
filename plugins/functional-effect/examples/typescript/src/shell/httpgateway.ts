// The live PaymentGateway: a client for a payment provider's HTTP API. Its job
// is translation, in both directions:
//
//   POST /v1/charges              Idempotency-Key: <key>   {"orderId","amount"}
//     200 {"status":"charged"}                   → succeed
//     402 {"status":"declined","reason":"…"}     → PaymentDeclined (domain outcome)
//   POST /v1/charges/<key>/resolve
//     200 {"status":"charged"|"declined"|"pending"|"not_found"}
//
//   408, 429, 5xx, network errors, lost responses → Transient (retry)
//   any other status or an unreadable 200          → a defect (Effect.die)
//
// The contract suite in contract/gateway.ts checks this mapping: against a
// simulator of the provider in every test run, and against the provider's
// sandbox when PAYMENTS_SANDBOX_URL is set.

import { Effect } from "effect"
import { type PaymentStatus, PaymentDeclined, PaymentGateway, Transient } from "./capabilities.js"

export interface HttpGatewayOptions {
  readonly baseUrl: string
  readonly apiKey?: string
  readonly timeoutMs?: number
}

interface Reply {
  readonly status: string
  readonly reason?: string
}

const statuses: Record<string, PaymentStatus> = {
  charged: "Charged",
  declined: "Declined",
  pending: "Pending",
  not_found: "NotFound",
}

export const httpGateway = (options: HttpGatewayOptions): PaymentGateway["Service"] => {
  const base = options.baseUrl.replace(/\/+$/, "")

  const post = (path: string, key: string, body?: unknown): Effect.Effect<Reply, Transient> =>
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(base + path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]),
          }),
        // Refused, reset, timed out, or the response was lost on the way back. The
        // request may or may not have been processed: transient, and safe to retry
        // only because of the idempotency key.
        catch: (e) => new Transient({ reason: `${path}: ${String(e)}` }),
      })
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: (e) => new Transient({ reason: `${path}: reading response: ${String(e)}` }),
      })
      if (res.status === 200 || res.status === 402) {
        const reply = yield* Effect.try({ try: () => JSON.parse(text) as Reply, catch: (e) => e }).pipe(Effect.orDie)
        return reply
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500)
        return yield* Effect.fail(new Transient({ reason: `${path}: HTTP ${res.status}` }))
      return yield* Effect.die(new Error(`${path}: HTTP ${res.status}: ${text}`))
    })

  return {
    charge: (key, orderId, amount) =>
      post("/v1/charges", key, { orderId, amount }).pipe(
        Effect.flatMap((r): Effect.Effect<void, PaymentDeclined> => {
          if (r.status === "charged") return Effect.void
          if (r.status === "declined") return Effect.fail(new PaymentDeclined({ reason: r.reason ?? "declined" }))
          return Effect.die(new Error(`charge ${key}: unexpected status ${r.status}`))
        }),
      ),
    resolve: (key) =>
      post(`/v1/charges/${encodeURIComponent(key)}/resolve`, key).pipe(
        Effect.flatMap((r) => {
          const status = statuses[r.status]
          return status ? Effect.succeed(status) : Effect.die(new Error(`resolve ${key}: unexpected status ${r.status}`))
        }),
      ),
  }
}
