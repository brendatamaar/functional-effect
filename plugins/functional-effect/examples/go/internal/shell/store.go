package shell

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"

	"example.com/functional-effect/internal/core"
)

// Store persists each order's state together with its commands, atomically.
//
// Commit is the heart of it: in one transaction it checks the expected version
// (optimistic concurrency), records the event ID (inbox: at-least-once delivery
// becomes exactly-once processing), appends the input to the event log, saves
// the new state and inserts the commands into the outbox. A crash can therefore
// never lose a command whose state was saved, nor save a state whose commands
// were lost. See skills/model/references/outbox.md for the SQL version.
type Store interface {
	Load(ctx context.Context, id core.OrderID) (core.State, Version, error)
	Commit(ctx context.Context, c Commit) error
	// ClaimDue leases up to limit outbox items due at now. A leased item that is
	// never completed (the worker crashed) becomes due again when the lease expires.
	ClaimDue(ctx context.Context, now time.Time, limit int) ([]OutboxItem, error)
	Complete(ctx context.Context, itemID string) error
	Release(ctx context.Context, itemID string, retryAt time.Time) error
	Events(ctx context.Context, id core.OrderID) ([]core.Input, error)
}

type Version int64

type Commit struct {
	OrderID  core.OrderID
	Expected Version
	EventID  string
	Input    core.Input
	State    core.State
	Outbox   []OutboxItem
}

type OutboxItem struct {
	ID      string
	OrderID core.OrderID
	Command core.Command
	DueAt   time.Time
}

var (
	ErrConflict  = errors.New("version conflict")
	ErrDuplicate = errors.New("event already processed")
)

// MemStore is an in-memory Store with the same transactional semantics as the
// SQL version: one mutex stands in for one database transaction.
type MemStore struct {
	mu     sync.Mutex
	lease  time.Duration
	seq    int64
	orders map[core.OrderID]*orderRow
	inbox  map[string]bool
	outbox map[string]*outboxRow
}

type orderRow struct {
	state   core.State
	version Version
	events  []core.Input
}

type outboxRow struct {
	item         OutboxItem
	seq          int64
	claimedUntil time.Time
}

func NewMemStore(lease time.Duration) *MemStore {
	return &MemStore{
		lease:  lease,
		orders: map[core.OrderID]*orderRow{},
		inbox:  map[string]bool{},
		outbox: map[string]*outboxRow{},
	}
}

func (m *MemStore) Load(_ context.Context, id core.OrderID) (core.State, Version, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if row, ok := m.orders[id]; ok {
		return row.state, row.version, nil
	}
	return core.Initial, 0, nil
}

func (m *MemStore) Commit(_ context.Context, c Commit) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.inbox[c.EventID] {
		return ErrDuplicate
	}
	row, ok := m.orders[c.OrderID]
	if !ok {
		row = &orderRow{state: core.Initial}
	}
	if row.version != c.Expected {
		return ErrConflict
	}
	m.inbox[c.EventID] = true
	row.state = c.State
	row.version++
	row.events = append(row.events, c.Input)
	m.orders[c.OrderID] = row
	for _, it := range c.Outbox {
		m.seq++
		m.outbox[it.ID] = &outboxRow{item: it, seq: m.seq}
	}
	return nil
}

func (m *MemStore) ClaimDue(_ context.Context, now time.Time, limit int) ([]OutboxItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var due []*outboxRow
	for _, r := range m.outbox {
		if !r.item.DueAt.After(now) && !r.claimedUntil.After(now) {
			due = append(due, r)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		if !due[i].item.DueAt.Equal(due[j].item.DueAt) {
			return due[i].item.DueAt.Before(due[j].item.DueAt)
		}
		return due[i].seq < due[j].seq
	})
	if len(due) > limit {
		due = due[:limit]
	}
	out := make([]OutboxItem, len(due))
	for i, r := range due {
		r.claimedUntil = now.Add(m.lease)
		out[i] = r.item
	}
	return out, nil
}

func (m *MemStore) Complete(_ context.Context, itemID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.outbox, itemID)
	return nil
}

func (m *MemStore) Release(_ context.Context, itemID string, retryAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.outbox[itemID]; ok {
		r.item.DueAt = retryAt
		r.claimedUntil = time.Time{}
	}
	return nil
}

func (m *MemStore) Events(_ context.Context, id core.OrderID) ([]core.Input, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if row, ok := m.orders[id]; ok {
		return append([]core.Input(nil), row.events...), nil
	}
	return nil, nil
}

// Peek returns the outbox items in insertion order (tests).
func (m *MemStore) Peek() []OutboxItem {
	m.mu.Lock()
	defer m.mu.Unlock()
	rows := make([]*outboxRow, 0, len(m.outbox))
	for _, r := range m.outbox {
		rows = append(rows, r)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].seq < rows[j].seq })
	out := make([]OutboxItem, len(rows))
	for i, r := range rows {
		out[i] = r.item
	}
	return out
}

// Pending reports how many outbox items are waiting (for tests and demos).
func (m *MemStore) Pending() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.outbox)
}

// NextDue reports the earliest due time in the outbox, if any.
func (m *MemStore) NextDue() (time.Time, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var next time.Time
	found := false
	for _, r := range m.outbox {
		at := r.item.DueAt
		if r.claimedUntil.After(at) {
			at = r.claimedUntil
		}
		if !found || at.Before(next) {
			next, found = at, true
		}
	}
	return next, found
}
