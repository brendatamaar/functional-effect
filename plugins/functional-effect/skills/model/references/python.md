# Model Functional Effect in Python

Python 3.11+, standard library for the core, a schema library at the boundary (pydantic shown), `Protocol`s for capabilities, and Hypothesis for properties. A runnable `core`-profile example (core, boundary, property tests) is in `examples/python`.

## Layout

```
<pkg>/core/     pure: types, step, run (no IO imports; `if TYPE_CHECKING:` imports are fine)
<pkg>/shell/    boundary (pydantic), capabilities, interpreter, app, fakes
main.py         the edge: build the capabilities, read the clock, start the app
tests/          property tests (core, boundary), contract suites, shell tests
```

Set `core` in `.functional-effect.json` to `["<pkg>/core/**"]` (or `src/<pkg>/core/**`, which is a default). Test files (`test_*.py`, `*_test.py`, `conftest.py`) are never checked.

## Sum types and value types

A closed sum type is a union of frozen dataclasses. `match` on the class, and end with an `assert_never` arm so a new variant fails the type checker (pyright/mypy) and fails loudly at runtime.

```python
from dataclasses import dataclass
from typing import NewType, NoReturn

OrderId = NewType("OrderId", str)
Amount = NewType("Amount", int)

def amount(raw: int) -> Amount:               # smart constructor: the only way to make one
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ValueError(f"invalid amount: {raw!r}")   # caught at the boundary only
    return Amount(raw)

@dataclass(frozen=True, slots=True)
class Draft: pass

@dataclass(frozen=True, slots=True)
class AwaitingPayment:
    order_id: OrderId
    amount: Amount
    attempt: int

@dataclass(frozen=True, slots=True)
class Paid:
    order_id: OrderId

State = Draft | AwaitingPayment | Paid

def assert_never(value: NoReturn) -> NoReturn:
    raise AssertionError(f"unhandled variant: {value!r}")
```

- A plain status with no data per value can be an `enum.Enum` or a `Literal["queued", "running", "done"]`; use dataclass variants as soon as one carries data the others do not. Never a raw `str` or a set of booleans (`is_loading`, `is_error`).
- `frozen=True` makes states values: `step` returns a new one, never mutates. Use `tuple`/`frozenset`/`Mapping`, not `list`/`dict`, inside them.
- No `default`/`case _:` that returns the state. `case _: assert_never(event)` is the exhaustiveness arm, not a catch-all.
- Do not put pydantic models in the core: they carry wire concerns (aliases, coercion). Validation lives in the smart constructors; the boundary maps wire models onto them.

## step: guards on state and attempt

```python
def step(state: State, event: Input) -> tuple[State, tuple[Command, ...]]:
    match event:
        case Submit(order_id=order, amount=amt):
            if not isinstance(state, Draft):
                return state, ()
            return AwaitingPayment(order, amt, 1), (
                ChargeCard(order, amt, 1, charge_key(order, 1)),
                ScheduleInput(30_000, PaymentTimedOut(order, 1)),
            )
        case PaymentSucceeded(order_id=order, attempt=attempt):
            if not (isinstance(state, AwaitingPayment) and state.order_id == order and state.attempt == attempt):
                return state, ()                      # late or duplicate result: ignored
            return Paid(order), ()
        case _:
            assert_never(event)
```

Time and keys are data: `ScheduleInput(after_ms, input)` is a command, `charge_key(order, attempt)` is a pure function of state. `datetime.now()`, `time.time()`, `uuid.uuid4()` and `random.*` are not allowed in the core; the clock, random values and generated IDs arrive as fields of an `Input`. Do not use `field(default_factory=datetime.now)` for the same reason (the checker flags `datetime.now` even as a function value).

UI or CLI state: the same `step` is a reducer; the shell calls `state, commands = step(state, event)` and dispatches the commands.

## Boundary (pydantic)

```python
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
from typing import Annotated, Literal

class SubmitWire(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    tag: Literal["Submit"]
    event_id: str = Field(alias="eventId", min_length=1)
    order_id: str = Field(alias="orderId", min_length=1)
    amount: int = Field(gt=0)

Wire = Annotated[SubmitWire | PaymentSucceededWire, Field(discriminator="tag")]
_adapter = TypeAdapter(Wire)

def parse_event(raw: object) -> Accepted | Rejected:
    try:
        w = _adapter.validate_python(raw)
    except ValidationError as err:
        return Rejected("; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in err.errors()))
    ...  # map wire models onto core types through the smart constructors
```

The parser returns a value, not an exception: rejection is a domain outcome the HTTP layer maps to a 400. Use `strict=True` so `"100"` and `True` are not coerced into an amount. Every value from outside (HTTP body, queue message, DB row, env, file, LLM output) is `object` until parsed. The example in `examples/python` does the same with the standard library only.

## Capabilities and the interpreter

```python
from typing import Protocol

class ChargeResult: ...   # a union: Charged | Declined(reason) | Unavailable

class PaymentGateway(Protocol):
    async def charge(self, key: str, order: OrderId, amount: Amount, *, timeout: float) -> ChargeResult: ...

@dataclass(frozen=True)
class Deps:
    gateway: PaymentGateway
    clock: Callable[[], datetime]

async def interpret(cmd: Command, deps: Deps) -> Input | None:
    match cmd:
        case ChargeCard():
            result = await with_retry(lambda: deps.gateway.charge(cmd.key, cmd.order_id, cmd.amount, timeout=5.0), is_unavailable)
            match result:
                case Charged(): return PaymentSucceeded(cmd.order_id, cmd.attempt)
                case Declined(reason=r): return PaymentFailed(cmd.order_id, cmd.attempt, r)
                case Unavailable(): return None        # unknown outcome: wait for the timer
        case ScheduleInput():
            return None                                # handled by the scheduler, not here
        case _:
            assert_never(cmd)
```

`Deps` is passed in, never imported as a global; `main.py` builds the real ones and tests build fakes. Domain outcomes (declined, not found) are returned values, not exceptions. Retry only commands that are idempotent or carry a key, and wrap retry, timeout and tracing around the capability or the interpreter (decorators or small wrappers) so the flow stays readable. Resources (connections, files, locks) use `with`/`async with` or `contextlib.closing`/`ExitStack`, so release happens on error and cancellation too. Execution (`asyncio.run`, the web framework's entry point) happens once, at the edge.

## Property tests with Hypothesis

```python
from hypothesis import given, settings, strategies as st

orders = st.sampled_from(["ord-1", "ord-2"]).map(order_id)                # small domain, so sequences collide
inputs = st.one_of(
    st.builds(Submit, orders, st.sampled_from([100, 500]).map(amount)),
    st.builds(PaymentSucceeded, orders, st.integers(1, 3)),
    st.builds(PaymentTimedOut, orders, st.integers(1, 3)),
)

@settings(max_examples=2000)
@given(st.lists(inputs, max_size=40))
def test_every_charge_key_is_issued_at_most_once(seq):
    _, commands = run(Draft(), seq)
    keys = [c.key for c in commands if isinstance(c, ChargeCard)]
    assert len(keys) == len(set(keys))
```

Hypothesis shrinks to the shortest failing sequence and stores it in its example database; use `@seed(...)` or `@reproduce_failure` to replay. One property per invariant, named after it, checked after every step where that makes sense. Boundary: round trip, accepted ⇒ valid (against a predicate written independently of the parser), rejects each broken rule; messy input is valid events perturbed with `st.fixed_dictionaries` / `st.one_of(st.none(), st.text(), st.integers())`. Contract suites are base classes or `pytest.fixture(params=[fake, live])` functions that run for the fake and the live adapter. Without Hypothesis, `examples/python/tests/prop.py` is a stdlib seeded generator with a remove-one-input shrinker.

## Persistence

For the `distributed` profile: load → `step` → commit in one transaction (version, inbox, event log, state, outbox), a worker draining the outbox. The SQL is in [outbox.md](outbox.md); the structure carries over from `examples/typescript` and `examples/go`. Use `psycopg`/`asyncpg` in the shell only.

## Enforcing it in CI

The plugin's hook checks edits made by Claude. For CI and human edits, use `templates/pyproject.functional-core.toml`: a nested `ruff.toml` in the core folder (banned imports, `T20` print, `DTZ` naive datetimes) and strict `pyright` for the exhaustive `match`.

## What the checker looks at

Imports of IO, network, database, process, concurrency, clock and randomness modules (`os`, `subprocess`, `socket`, `asyncio`, `threading`, `time`, `random`, `logging`, `requests`, `sqlalchemy`, …, and any submodule); calls to `print`, `input`, `open`, `breakpoint`, `datetime.now/utcnow/today`, `uuid.uuid1/uuid4`, `os.environ/getenv`, `sys.argv/exit/stdout`. Imports under `if TYPE_CHECKING:`, relative imports, comments, docstrings and string contents are not flagged; expressions inside f-strings are. Allow a pure submodule with `rules.py.allowImports` (`"os.path"`, `"pathlib"` for `PurePath`).

It is a static, line-level analysis: `importlib.import_module("os")`, `__import__`, and effects hidden behind your own helpers are not seen. The reviewer agent and the CI templates cover more.
