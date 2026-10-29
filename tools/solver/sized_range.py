"""Empirical public-action likelihoods; offline candidate, not Nash ranges.

Fixed features/smoothing chosen before the heldout match is scored. No actual
opponent cards enter inference. Amounts are incremental chips in bb.
"""
from functools import lru_cache
import itertools
import math
import numpy as np
from eval7 import eval7
from opponent_model import estimated_range
from ranges import parse_card

VERSION = 'public-size-likelihood-v1'
EVENTS = ['check', 'call_small', 'call_large', 'fold_small', 'fold_large'] + [
    f'{a}_{i}' for a in ('bet', 'raise') for i in range(4)]


def event_name(action, amount, pot, call):
    if action == 'check':
        return 'check'
    if action in ('fold', 'call'):
        return action + ('_small' if call/max(pot-call, 1e-9) <= .6 else '_large')
    if action in ('bet', 'raise'):
        fraction = max(0., amount-call)/max(pot+call, 1e-9)
        size = next((i for i, bound in enumerate((.4, .8, 1.5)) if fraction <= bound), 3)
        return ('raise' if call > 1e-9 else 'bet') + '_' + str(size)
    return None


def history_context(history):
    pot, wagers, street = 0., {}, 'preflop'
    for a in history:
        if a['street'] != street:
            street, wagers = a['street'], {}
        pid, label = str(a['playerId']), a['action']
        call = max(wagers.values(), default=0.) - wagers.get(pid, 0.)
        amount = float(a.get('amountBB', 0))
        if not math.isfinite(amount) or amount < 0:
            raise ValueError('Invalid public action amount')
        if label == 'call':
            call = min(call, amount)  # Actual short-all-in payment, not table price.
        elif a.get('moneyLeftBB') is not None:
            left = float(a['moneyLeftBB'])
            if not math.isfinite(left) or left < 0:
                raise ValueError('Invalid remaining stack')
            call = min(call, amount+left)
        if len(a.get('board', [])) >= 3:
            event = event_name(label, amount, pot, call)
            if event:
                yield pid, a['board'], event, amount, pot, call
        pot += amount
        wagers[pid] = wagers.get(pid, 0.) + (float(a.get('liveAmountBB', 0)) if label == 'ante' else amount)


def history_events(history):
    for context in history_context(history):
        yield context[:3]


@lru_cache(maxsize=512)
def rank_distribution(board):
    hands = np.array(list(itertools.combinations([c for c in range(52) if c not in board], 2)))
    values = eval7(np.column_stack((hands, np.tile(board, (len(hands), 1)))))
    unique, counts = np.unique(values, return_counts=True)
    return unique, (np.cumsum(counts)-counts/2)/len(hands)


def buckets(hands, board):
    hands = np.asarray(hands)
    unique, quantiles = rank_distribution(tuple(board))
    cards = np.column_stack((hands, np.tile(board, (len(hands), 1))))
    values = eval7(cards)
    percentile = quantiles[np.searchsorted(unique, values)]
    strength = np.minimum(4, (percentile*5).astype(int))
    suits = cards & 3
    draw = np.zeros(len(hands), dtype=int)
    if len(board) < 5:
        # A flush draw must use a hole card; four board cards alone are not it.
        for suit in range(4):
            draw |= (((suits == suit).sum(axis=1) == 4) & ((hands & 3) == suit).any(axis=1))
    return strength*2 + draw


def fit(records):
    counts = np.zeros((3, 10, len(EVENTS)))
    for board, hand, event in records:
        counts[len(board)-3, buckets([hand], board)[0], EVENTS.index(event)] += 1
    # Dirichlet shrinkage toward the same-street pooled event distribution.
    pooled = counts.sum(axis=1) + 1
    pooled /= pooled.sum(axis=1, keepdims=True)
    likelihood = (counts + 20*pooled[:, None, :])/(counts.sum(axis=2, keepdims=True)+20)
    return dict(version=VERSION, smoothing=20, events=EVENTS, observations=int(counts.sum()),
                counts=counts.tolist(), likelihood=likelihood.tolist())


def sized_range(player, history, board, model):
    if model.get('version') != VERSION or model.get('events') != EVENTS:
        raise ValueError('Unsupported size model')
    table = np.asarray(model['likelihood'], dtype=float)
    if table.shape != (3, 10, len(EVENTS)) or not np.isfinite(table).all() or (table <= 0).any():
        raise ValueError('Invalid size model likelihood')
    arr, weights = estimated_range(player, [a for a in history if a['street'] == 'preflop'], board)
    weights = weights.astype(float)
    for pid, action_board, event in history_events(history):
        if pid != str(player['id']):
            continue
        b = [parse_card(c) for c in action_board]
        weights *= table[len(b)-3, buckets(arr, b), EVENTS.index(event)]
        weights /= weights.max()
    return arr, weights.astype(np.float32)
