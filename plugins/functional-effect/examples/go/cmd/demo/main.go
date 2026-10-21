// The edge of the program: wire capabilities, run the worker, show the log.
//
// Scenario: the first charge goes through but its response is lost, and the
// retries never reach the gateway. The shell does not guess. Ten minutes later
// the timer fires, the order is reconciled with a fenced Resolve, and it ships.
// The same webhook is then delivered twice, and the state is replayed from the
// event log to prove the stored state is just Run(events).
package main

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"time"

	"example.com/functional-effect/internal/core"
	"example.com/functional-effect/internal/shell"
)

func main() {
	ctx := context.Background()
	now := time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

	gateway := shell.NewFakeGateway(func(op string, _ core.IdempotencyKey, n int) shell.Behavior {
		switch {
		case op == "charge" && n == 1:
			return shell.LostResponse
		case op == "charge":
			return shell.Transient
		}
		return shell.Normal
	})
	notifier := &shell.FakeNotifier{}
	store := shell.NewMemStore(30 * time.Second)
	app := &shell.App{Store: store, Now: func() time.Time { return now }}
	worker := &shell.Worker{
		App: app,
		Deps: shell.Deps{
			Payments: gateway,
			Shipping: shell.NewFakeShipping(nil),
			Notifier: notifier,
			Log:      func(f string, a ...any) { fmt.Printf("  [shell] "+f+"\n", a...) },
		},
	}

	show := func(label string, id core.OrderID) {
		s, v, _ := store.Load(ctx, id)
		fmt.Printf("%s  %-28s v%d  %s\n", now.Format("15:04"), label, v, core.Describe(s))
	}
	drain := func() {
		for {
			n, err := worker.RunOnce(ctx, now)
			if err != nil {
				fmt.Println("worker:", err)
				os.Exit(1)
			}
			if n == 0 {
				return
			}
		}
	}

	ev, err := shell.ParseEvent([]byte(`{"eventId":"evt-1","_tag":"Submit","orderId":"ord-1","amount":4200}`))
	if err != nil {
		fmt.Println("rejected:", err)
		os.Exit(1)
	}
	id := ev.Input.(core.Submit).OrderID
	if _, err := app.Handle(ctx, ev.ID, ev.Input); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	show("submitted", id)

	drain()
	show("charge outcome unknown", id)

	now = now.Add(core.PaymentTimeout)
	drain()
	show("timer fired, reconciled", id)

	for i := 0; i < 2; i++ {
		dup, _ := shell.ParseEvent([]byte(`{"eventId":"wh-77","_tag":"PaymentSucceeded","orderId":"ord-1","attempt":1}`))
		if _, err := app.Handle(ctx, dup.ID, dup.Input); err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
	}
	show("late webhook ×2 (ignored)", id)

	if _, err := shell.ParseEvent([]byte(`{"eventId":"evt-x","_tag":"Submit","orderId":"","amount":-5}`)); err != nil {
		fmt.Println("       rejected at boundary:", err)
	}

	stored, _, _ := store.Load(ctx, id)
	replayed, _ := app.Replay(ctx, id)
	events, _ := store.Events(ctx, id)
	fmt.Printf("\nevent log (%d inputs):\n", len(events))
	for i, e := range events {
		fmt.Printf("  %d. %T%+v\n", i+1, e, e)
	}
	fmt.Printf("replayed state equals stored state: %v\n", reflect.DeepEqual(stored, replayed))
	fmt.Printf("money moved: %d time(s); customer notified: %q\n", gateway.Charged(id), notifier.Sent)

	if _, ok := stored.(core.Shipped); !ok || gateway.Charged(id) != 1 || !reflect.DeepEqual(stored, replayed) {
		os.Exit(1)
	}
}
