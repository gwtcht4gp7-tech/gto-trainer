"""2-6 player no-limit hold'em simulator, in bb. No hidden cards in infosets.

All sampled continuations reach a fold or river showdown, with layered pots.
Bet sizes and information sets are abstracted by the solver, not by these rules.
"""
from dataclasses import dataclass, replace
from collections import Counter
from functools import lru_cache
import math

EPS = 1e-7


@lru_cache(maxsize=100000)
def rank7(cards):
    """Comparable exact best-five rank, without numpy per-hand overhead."""
    counts = Counter(c >> 2 for c in cards)
    ranks = sorted(counts, reverse=True)

    def straight(rs):
        mask = sum(1 << r for r in rs)
        for high in range(12, 3, -1):
            if mask & (31 << (high - 4)) == 31 << (high - 4):
                return high
        return 3 if mask & 4111 == 4111 else -1

    flush = []
    for suit in range(4):
        suited = sorted((c >> 2 for c in cards if c & 3 == suit), reverse=True)
        if len(suited) >= 5:
            flush = suited
            high = straight(suited)
            if high >= 0:
                return (8, high)
            break
    groups = sorted(((count, r) for r, count in counts.items()), reverse=True)
    if groups[0][0] == 4:
        r = groups[0][1]
        return (7, r, max(x for x in ranks if x != r))
    trips = [r for r in ranks if counts[r] >= 3]
    if trips:
        pairs = [r for r in ranks if counts[r] >= 2 and r != trips[0]]
        if pairs:
            return (6, trips[0], pairs[0])
    if flush:
        return (5, *flush[:5])
    high = straight(ranks)
    if high >= 0:
        return (4, high)
    if trips:
        return (3, trips[0], *[r for r in ranks if r != trips[0]][:2])
    pairs = [r for r in ranks if counts[r] >= 2]
    if len(pairs) >= 2:
        return (2, pairs[0], pairs[1], max(r for r in ranks if r not in pairs[:2]))
    if pairs:
        return (1, pairs[0], *[r for r in ranks if r != pairs[0]][:3])
    return (0, *ranks[:5])


def clockwise(n, after):
    return [(after + k) % n for k in range(1, n + 1)]


@dataclass(frozen=True)
class Action:
    label: str
    amount: float = 0.


@dataclass(frozen=True)
class State:
    stacks: tuple
    committed: tuple
    bets: tuple
    folded: tuple
    dealer: int
    street: int
    pending: tuple
    price: float
    min_raise: float
    acted_price: tuple
    full_bet: bool
    board: tuple
    runout: tuple
    holes: tuple
    history: tuple = ()
    terminal: bool = False
    exact_root_player: int = -1
    exact_root_depth: int = -1
    extra_root_action: Action | None = None

    @property
    def player(self):
        return self.pending[0] if not self.terminal else -1

    @property
    def pot(self):
        return sum(self.committed)

    @property
    def n(self):
        return len(self.stacks)

    def actions(self):
        if self.terminal:
            return ()
        p = self.player
        call = max(0., self.price - self.bets[p])
        out = [Action('fold'), Action('call', min(call, self.stacks[p]))] if call > EPS else [Action('check')]
        others = [i for i in range(self.n) if i != p and not self.folded[i]]
        if not any(self.stacks[i] > EPS for i in others):
            return tuple(out)
        reopened = self.acted_price[p] < 0 or self.price - self.acted_price[p] >= self.min_raise - EPS
        if not reopened:
            return tuple(out)
        cap = min(self.bets[p] + self.stacks[p], max(self.bets[i] + self.stacks[i] for i in others))
        if cap <= self.price + EPS:
            return tuple(out)
        minimum = self.price + self.min_raise
        seen = set()
        for fraction in (.5, 1.):
            target = min(cap, max(minimum, self.price + fraction * (self.pot + call)))
            if target < minimum - EPS and target < cap - EPS:
                continue
            amount = round(target - self.bets[p], 8)
            if amount <= call + EPS or amount in seen:
                continue
            seen.add(amount)
            label = 'allin' if target >= cap - EPS else ('raise' if call > EPS else 'bet') + str(round(fraction * 100))
            out.append(Action(label, amount))
        amount = round(cap - self.bets[p], 8)
        if amount not in seen:
            out.append(Action('allin', amount))
        if self.extra_root_action is not None and p == self.exact_root_player and len(self.history) == self.exact_root_depth:
            if all(abs(a.amount-self.extra_root_action.amount) > EPS for a in out if a.label != 'fold'):
                out.append(self.extra_root_action)
        return tuple(out)

    def step(self, action):
        p = self.player
        stacks, paid, bets, folded, acted = map(list, (self.stacks, self.committed, self.bets, self.folded, self.acted_price))
        price, minimum, full = self.price, self.min_raise, self.full_bet
        pending = list(self.pending[1:])
        if action.label == 'fold':
            folded[p] = True
        else:
            amount = action.amount
            if amount < -EPS or amount > stacks[p] + EPS:
                raise ValueError('Illegal investment')
            stacks[p] = max(0., stacks[p] - amount)
            paid[p] += amount; bets[p] += amount
            if bets[p] > price + EPS:
                previous = price
                price = bets[p]
                if price - previous >= minimum - EPS:
                    minimum = price - previous
                    full = True
                pending = [i for i in clockwise(self.n, p) if i != p and not folded[i] and stacks[i] > EPS
                           and (i in pending or bets[i] < price - EPS)]
                # Every full raise requires all other live players to respond.
                if price - previous >= self.min_raise - EPS:
                    pending = [i for i in clockwise(self.n, p) if i != p and not folded[i] and stacks[i] > EPS]
            acted[p] = price
        pending = tuple(i for i in pending if not folded[i] and stacks[i] > EPS)
        token = (self.street, p, action.label)
        result = replace(self, stacks=tuple(stacks), committed=tuple(paid), bets=tuple(bets),
                         folded=tuple(folded), price=price, min_raise=minimum, full_bet=full,
                         acted_price=tuple(acted), pending=pending, history=self.history + (token,))
        return result.settle()

    def settle(self):
        alive = [i for i in range(self.n) if not self.folded[i]]
        if len(alive) == 1:
            return replace(self, pending=(), terminal=True)
        if self.pending:
            # With one player holding chips, only an outstanding call needs action.
            actionable = [i for i in alive if self.stacks[i] > EPS]
            if len(actionable) > 1 or any(self.bets[i] < self.price - EPS for i in actionable):
                return self
        elif sum(self.stacks[i] > EPS for i in alive) > 1 and self.street < 3:
            street = self.street + 1
            pending = tuple(i for i in clockwise(self.n, self.dealer) if not self.folded[i] and self.stacks[i] > EPS)
            return replace(self, street=street, pending=pending, bets=(0.,) * self.n,
                           acted_price=(-1.,) * self.n, price=0., min_raise=1., full_bet=False,
                           board=self.runout[:street + 2])
        return replace(self, street=3, board=self.runout, pending=(), terminal=True)

    def payouts(self):
        if not self.terminal:
            raise ValueError('Showdown requested before terminal')
        result = [0.] * self.n
        live = [i for i in range(self.n) if not self.folded[i]]
        if len(live) == 1:
            result[live[0]] = self.pot
            return result
        values = {i: rank7(tuple(sorted(self.holes[i] + self.board))) for i in live}
        previous = 0.
        for level in sorted({x for x in self.committed if x > EPS}):
            contributors = [i for i, x in enumerate(self.committed) if x >= level - EPS]
            amount = (level - previous) * len(contributors)
            eligible = [i for i in contributors if not self.folded[i]]
            if len(contributors) == 1:
                winners = contributors  # Uncalled chips are returned.
            elif not eligible:
                raise ValueError('Inconsistent side pot: no eligible player')
            else:
                best = max(values[i] for i in eligible)
                winners = [i for i in eligible if values[i] == best]
            for i in winners:
                result[i] += amount / len(winners)
            previous = level
        return result

    def returns(self):
        return tuple(win - paid for win, paid in zip(self.payouts(), self.committed))

    def info_key(self, actions=None, exact=True):
        """Bucketed own-card information; opponents' cards/runout are excluded."""
        p = self.player
        hole = self.holes[p]
        ranks = sorted((c >> 2 for c in hole), reverse=True)
        pre = (min(3, (ranks[0] + ranks[1]) // 6), ranks[0] == ranks[1], hole[0] & 3 == hole[1] & 3)
        own = pre
        if self.board:
            made = rank7(tuple(sorted(hole + self.board)))
            board_ranks = sorted(set(c >> 2 for c in self.board), reverse=True)
            pair_tier = 0 if made[0] != 1 else (2 if made[1] >= board_ranks[0] else 1)
            suits = Counter(c & 3 for c in hole + self.board)
            mask = {c >> 2 for c in hole + self.board}
            draw = len(self.board) < 5 and any(len(mask & set(range(k, k + 5))) >= 4 for k in range(9))
            own = (pre, made[0], pair_tier, max(suits.values()) >= 4, draw,
                   tuple(rank7(tuple(sorted(hole + self.board[:k])))[0] for k in range(3, len(self.board))))
        texture = () if not self.board else (max(c >> 2 for c in self.board) // 3,
                   len(self.board) - len(set(c >> 2 for c in self.board)),
                   max(Counter(c & 3 for c in self.board).values()))
        pot = max(1., self.pot)
        spr = tuple(min(12, int(math.log2(1 + x / pot) * 2)) for x in self.stacks)
        folded = tuple(i for i, f in enumerate(self.folded) if f)
        labels = tuple(a.label for a in (actions or self.actions()))
        if exact and p == self.exact_root_player and len(self.history) == self.exact_root_depth:
            own = ('root-own-cards', tuple(sorted(hole)), round((self.price-self.bets[p])/pot,3),
                   round(self.min_raise/pot,3))
        key = ('nlhe-os-v1', self.n, (p - self.dealer) % self.n, self.street,
               own, texture, spr, folded, self.history, labels)
        # Isolate blueprints trained before the incomplete-opening correction.
        if self.street > 0 and EPS < self.price < 1-EPS:
            key += ('short-opening-v2',)
        return repr(key)


def new_hand(stacks, dealer, holes, runout):
    n = len(stacks)
    bets = [0.] * n
    small, big = (dealer, (dealer + 1) % n) if n == 2 else ((dealer + 1) % n, (dealer + 2) % n)
    for seat, amount in ((small, .5), (big, 1.)):
        bets[seat] = min(stacks[seat], amount)
    left = tuple(x - y for x, y in zip(stacks, bets))
    pending = tuple(i for i in clockwise(n, big) if left[i] > EPS)
    return State(left, tuple(bets), tuple(bets), (False,) * n, dealer, 0, pending, 1., 1.,
                 (-1.,) * n, True, (), tuple(runout), tuple(map(tuple, holes))).settle()
