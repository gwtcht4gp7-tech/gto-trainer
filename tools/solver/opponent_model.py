"""Estimated ranges from public history; these are not solved Nash ranges."""
import itertools
import numpy as np
from eval7 import eval7
from ranges import combos, open_range, call_range, threebet_range, parse_card


def estimated_range(player, history, board, limit=None):
    dead = set(board)
    arr = np.array(list(itertools.combinations([c for c in range(52) if c not in dead], 2)), np.int64)
    pos = player.get('pos') or 'BB'
    actions = [a for a in history if str(a.get('playerId')) == str(player.get('id'))]
    voluntary = [a for a in actions if a.get('street') == 'preflop' and
                 a.get('action') in ('call', 'bet', 'raise')]
    raises = sum(a.get('action') in ('bet', 'raise') for a in voluntary)
    # A player who checked their BB retains the entire starting range.
    spec = None
    if raises:
        before = [a for a in history if a.get('street') == 'preflop' and
                  a.get('action') in ('bet', 'raise')]
        first = next((i for i, a in enumerate(before)
                      if str(a.get('playerId')) == str(player.get('id'))), 0)
        spec = threebet_range(pos) if first > 0 or raises > 1 else open_range(pos)
    elif voluntary:
        spec = call_range(pos)
    baseline = set(map(tuple, np.sort(combos(spec, board), axis=1))) if spec else None
    weights = np.array([1.0 if baseline is None or tuple(c) in baseline else .08 for c in arr])
    profile = player.get('profile') or {}
    # Bayesian rates are already shrunk by the recorder; cap the influence.
    learned = min(1., max(0., float(profile.get('sampleWeight', 0))))
    rate = float(profile.get('pfrRate' if raises else 'vpipRate', .18 if raises else .30))
    base_rate = .18 if raises else .30
    widen = np.clip(rate - base_rate, -.15, .25) * learned
    if voluntary and baseline:
        weights = np.where(weights < .5, np.clip(.08 + widen * 2, .025, .45), 1.)
    for a in actions:
        b = [parse_card(c) for c in a.get('board', [])]
        if len(b) < 3 or a.get('action') not in ('call', 'bet', 'raise'):
            continue
        values = eval7(np.column_stack((arr, np.tile(b, (len(arr), 1)))))
        # Equal made hands receive equal likelihood, independent of suit ordering.
        _, inv, counts = np.unique(values, return_inverse=True, return_counts=True)
        pct = (np.cumsum(counts) - counts / 2) / len(arr)
        q = pct[inv]
        suits = np.column_stack((arr, np.tile(b, (len(arr), 1)))) & 3
        draw = np.max(np.stack([(suits == s).sum(axis=1) for s in range(4)]), axis=0) >= 4
        aggression = float(profile.get('aggressionRate', .4))
        bluff_floor = np.clip(.15 + (aggression - .4) * learned * .4, .08, .3)
        likelihood = bluff_floor + (1 - bluff_floor) * q ** (2 if a['action'] != 'call' else 1)
        if len(b) < 5:
            likelihood = np.maximum(likelihood, np.where(draw, .65, 0))
        weights *= likelihood
        weights /= max(weights.max(), 1e-12)
    if limit and len(arr) > limit:
        # Stratify by preflop strength; retain weights rather than selecting only premiums.
        ranks = arr >> 2
        score = ranks.max(axis=1) + ranks.min(axis=1) * .4 + (ranks[:, 0] == ranks[:, 1]) * 8
        order = np.argsort(score, kind='stable')
        idx = order[np.unique(np.round(np.linspace(0, len(arr) - 1, limit)).astype(int))]
        arr, weights = arr[idx], weights[idx]
    return arr, weights.astype(np.float32)


def joint_equity(hero, board, opponents, history, samples=6000, seed=20261027,
                 compare_opponent=None, range_estimates=None):
    """Independent weighted range prior conditioned jointly on all card blockers.

    Reject whole joint deals, not sequentially renormalized opponents. Split pots
    count as shares, and unknown runouts are uniform without replacement.
    """
    rng = np.random.default_rng(seed)
    ranges = []
    if range_estimates is not None and len(range_estimates) != len(opponents):
        raise ValueError('Range estimates and opponents disagree')
    for i, p in enumerate(opponents):
        arr, w = estimated_range(p, history, board) if range_estimates is None else range_estimates[i]
        arr, w = np.asarray(arr, dtype=np.int64), np.asarray(w, dtype=float)
        if arr.ndim != 2 or arr.shape[1] != 2 or w.shape != (len(arr),) or not np.isfinite(w).all() or (w < 0).any():
            raise ValueError('Invalid explicit range estimate')
        if (arr < 0).any() or (arr >= 52).any() or (arr[:, 0] == arr[:, 1]).any():
            raise ValueError('Invalid explicit range cards')
        valid = ~np.isin(arr, list(hero) + list(board)).any(axis=1)
        arr, w = arr[valid], w[valid]
        if not len(arr) or w.sum() <= 0:
            raise ValueError('No legal opponent range')
        ranges.append((arr, w / w.sum()))
    accepted, n = [], 0
    for _ in range(80):
        size = min(16000, max(2048, (samples - n) * 2))
        holes = np.stack([a[rng.choice(len(a), size, p=w / w.sum())] for a, w in ranges], axis=1)
        flat = np.sort(holes.reshape(size, -1), axis=1)
        valid = (np.diff(flat, axis=1) != 0).all(axis=1)
        got = holes[valid][:samples - n]
        accepted.append(got); n += len(got)
        if n >= samples:
            break
    if n < samples:
        raise ValueError('Not enough mutually legal joint deals')
    holes = np.concatenate(accepted)
    blocked = np.zeros((n, 52), bool)
    blocked[:, list(board) + list(hero)] = True
    for i in range(len(opponents)):
        blocked[np.arange(n)[:, None], holes[:, i]] = True
    keys = rng.random((n, 52)); keys[blocked] = 2
    runout = np.argsort(keys, axis=1)[:, :5 - len(board)]
    full_board = np.column_stack((np.tile(board, (n, 1)), runout))
    scores = [eval7(np.column_stack((np.tile(hero, (n, 1)), full_board)))]
    scores += [eval7(np.column_stack((holes[:, i], full_board))) for i in range(len(opponents))]
    scores = np.stack(scores, axis=1)
    winners = scores == scores.max(axis=1)[:, None]
    shares = winners[:, 0] / winners.sum(axis=1)
    result = {'heroEquity': float(shares.mean()), 'standardError': float(shares.std(ddof=1) / np.sqrt(n)),
              'samples': n, 'opponentCount': len(opponents), 'splitPotShares': True}
    if compare_opponent is not None:
        if not 0 <= compare_opponent < len(opponents):
            raise ValueError('Invalid reference opponent')
        other = scores[:, compare_opponent + 1]
        heads_up = (scores[:, 0] > other).astype(float) + .5 * (scores[:, 0] == other)
        difference = shares - heads_up
        result['headsUpReference'] = {
            'opponentId': str(opponents[compare_opponent]['id']),
            'equity': float(heads_up.mean()),
            'standardError': float(heads_up.std(ddof=1) / np.sqrt(n)),
            'pairedEquityDifference': float(difference.mean()),
            'pairedStandardError': float(difference.std(ddof=1) / np.sqrt(n)),
            'sameJointDeals': True,
        }
    return result
