---
name: extract-pins-behavior
tags: [extract]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
Use the extract approach on this handler (src/routes/checkout.ts). Show your plan and the first step; do not write files.

```ts
export async function checkout(req: Request, res: Response) {
  const order = await db.orders.find(req.body.orderId)
  if (!order) return res.status(404).end()
  if (order.status === "paid") return res.status(200).json(order)
  let total = order.items.reduce((s, i) => s + i.price * i.qty, 0)
  if (order.coupon) total = total - total * 0.1
  if (order.coupon) total = total - 5            // applied twice? nobody is sure
  const r = await payments.charge(order.customerId, total)
  if (r.ok) {
    await db.orders.update(order.id, { status: "paid", paidAt: Date.now() })
    await mailer.send(order.email, "Thanks!")
    return res.status(200).json({ ...order, status: "paid" })
  }
  await db.orders.update(order.id, { status: "failed" })
  return res.status(402).json({ error: r.reason })
}
```
