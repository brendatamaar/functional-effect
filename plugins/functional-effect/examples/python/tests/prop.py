"""A tiny property-test helper: seeded generation and a remove-one-input shrinker.

Stdlib only. In a real project use Hypothesis (`st.lists(inputs)` shrinks and
replays failures for you); the shape of the tests below carries over.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from typing import TypeVar

T = TypeVar("T")


def shrink(items: Sequence[T], fails: Callable[[Sequence[T]], bool]) -> list[T]:
    """Greedily drop one element at a time while the sequence still fails."""
    current = list(items)
    changed = True
    while changed:
        changed = False
        for i in range(len(current)):
            candidate = current[:i] + current[i + 1 :]
            if fails(candidate):
                current = candidate
                changed = True
                break
    return current


def check_sequences(
    gen: Callable[[random.Random], T],
    prop: Callable[[Sequence[T]], bool],
    *,
    runs: int = 2000,
    max_len: int = 12,
    seed: int = 1,
) -> None:
    """Raise AssertionError with the shortest failing sequence and the seed."""
    rng = random.Random(seed)
    for _ in range(runs):
        seq = [gen(rng) for _ in range(rng.randint(0, max_len))]
        if not prop(seq):
            small = shrink(seq, lambda s: not prop(s))
            raise AssertionError(f"property failed (seed={seed}); shortest failing sequence:\n  " + "\n  ".join(map(repr, small)))
