// A simulator of the payment provider's HTTP API (the one httpGateway speaks),
// so the live adapter can run the PaymentGateway contract suite in every test
// run, without network access.
//
// A simulator encodes our reading of the provider's documentation, so it can be
// wrong in the same way the fake is. The sandbox run of the contract suite
// (PAYMENTS_SANDBOX_URL) is what checks that reading against the real provider.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

type Op = "charge" | "resolve"

export interface GatewaySim {
  readonly url: string
  /** The next request for op answers 503 without doing anything. */
  failNext(op: Op): void
  /** The next request for op does its work, then drops the connection unanswered. */
  loseNext(op: Op): void
  /** How many times money moved for an order. */
  charged(orderId: string): number
  close(): Promise<void>
}

export const startGatewaySim = async (declineAmount: number): Promise<GatewaySim> => {
  const results = new Map<string, "charged" | "declined">()
  const charged = new Map<string, number>()
  const fail = new Map<Op, number>()
  const lose = new Map<Op, number>()
  const take = (m: Map<Op, number>, op: Op) => {
    const n = m.get(op) ?? 0
    if (n > 0) m.set(op, n - 1)
    return n > 0
  }
  const reply = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body))
  }
  const readBody = async (req: IncomingMessage) => {
    let text = ""
    for await (const chunk of req) text += chunk
    return text
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://sim")
    const key = String(req.headers["idempotency-key"] ?? "")
    const body = await readBody(req)
    if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" })

    if (url.pathname === "/v1/charges") {
      if (take(fail, "charge")) return reply(res, 503, { error: "unavailable" })
      const { orderId, amount } = JSON.parse(body) as { orderId: string; amount: number }
      let result = results.get(key)
      if (result === undefined) {
        result = amount === declineAmount ? "declined" : "charged"
        if (result === "charged") charged.set(orderId, (charged.get(orderId) ?? 0) + 1)
        results.set(key, result)
      }
      if (take(lose, "charge")) return void req.socket.destroy()
      return reply(res, result === "declined" ? 402 : 200, { status: result, reason: "card declined" })
    }

    const m = /^\/v1\/charges\/([^/]+)\/resolve$/.exec(url.pathname)
    if (m) {
      if (take(fail, "resolve")) return reply(res, 503, { error: "unavailable" })
      const k = decodeURIComponent(m[1] ?? "")
      const result = results.get(k)
      if (result === undefined) results.set(k, "declined") // void: a later charge with this key is declined
      if (take(lose, "resolve")) return void req.socket.destroy()
      return reply(res, 200, { status: result ?? "not_found" })
    }
    return reply(res, 404, { error: "not found" })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    failNext: (op) => void fail.set(op, (fail.get(op) ?? 0) + 1),
    loseNext: (op) => void lose.set(op, (lose.get(op) ?? 0) + 1),
    charged: (orderId) => charged.get(orderId) ?? 0,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
