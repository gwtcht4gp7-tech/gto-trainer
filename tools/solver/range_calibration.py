"""Offline log-score audit of single-opponent public range priors.

Held-out dealt cards are labels only, never estimator inputs. Observed actions
are not optimal-policy labels. Cluster by hand, not repeated decision snapshots.
No parameter fitting, production writes or profit claims.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tomllib

import numpy as np
from opponent_model import estimated_range
from public_replay import prefixes
from practical_replay import validate
from ranges import parse_card


def log_score(arr, weights, cards, dead):
    arr, weights = np.asarray(arr), np.asarray(weights, dtype=float)
    valid = ~np.isin(arr, list(dead)).any(axis=1)
    arr, weights = arr[valid], weights[valid]
    if not len(arr) or weights.sum() <= 0 or not np.isfinite(weights).all() or (weights < 0).any():
        raise ValueError('Invalid prior')
    target = np.sort(cards)
    if any(c in dead for c in target):
        raise ValueError('Heldout label conflicts with observed cards')
    probability = weights[(np.sort(arr, axis=1) == target).all(axis=1)].sum() / weights.sum()
    return math.log(probability) if probability > 0 else -math.inf


def predict(req):
    validate(req)
    board = [parse_card(c) for c in req['board']]
    # Crucially, no actual other-player cards are available at this boundary.
    return {p['id']: estimated_range(p, req['history'], board) for p in req['opponents']}


def score(req, priors, labels):
    dead = {parse_card(c) for c in req['board'] + req['heroCards']}
    uniform = -math.log(math.comb(52-len(dead), 2))
    rows = []
    for p in req['opponents']:
        cards = labels.get(p['id'])
        if cards is None:
            continue
        arr, weights = priors[p['id']]
        value = log_score(arr, weights, cards, dead)
        rows.append(dict(opponentId=p['id'], modelLogScore=value, uniformLogScore=uniform,
                         gainNats=value-uniform))
    return rows


def summarize(rows):
    by_hand = {}
    for row in rows:
        by_hand.setdefault(row['hand'], []).append(row['gainNats'])
    means = np.array([np.mean(v) for v in by_hand.values()])
    se = float(means.std(ddof=1)/math.sqrt(len(means))) if len(means) > 1 else None
    return dict(labels=len(rows), handClusters=len(means), meanHandGainNats=float(means.mean()),
                handClusterSE=se, approximate95Interval=None if se is None else
                [float(means.mean())-1.96*se, float(means.mean())+1.96*se])


def audit(sources):
    rows = []
    for source in sources:
        raw = tomllib.loads(source['content'])
        labels = {}
        for action in raw['actions']:
            words = action.split()
            if words[:2] == ['d', 'dh'] and len(words[3]) == 4 and '?' not in words[3]:
                labels[words[2]] = [parse_card(words[3][:2]), parse_card(words[3][2:])]
        for prefix in prefixes(source['content']):
            req = prefix['request']
            priors = predict(req)  # labels are not passed to prediction
            for row in score(req, priors, labels):
                rows.append(dict(hand=source['name'], step=prefix['prefixActionIndex'],
                                 street=req['street'], **row))
    return dict(scope='Single-opponent range-prior density calibration; not policy value or joint-prior certification',
                sources=[dict(name=s['name'], url=s['url'], sha256=hashlib.sha256(s['content'].encode()).hexdigest())
                         for s in sources],
                summary=summarize(rows),
                byStreet={s: summarize([r for r in rows if r['street'] == s])
                          for s in sorted({r['street'] for r in rows})},
                rows=rows,
                limits=['Ten hands are a small convenience cohort, not a representative poker population.',
                        'Positive log score rewards density on observed cards, not profitable decisions.',
                        'Repeated observations within a hand are clustered together.',
                        'Normal intervals with ten clusters are descriptive only; no deployment threshold.',
                        'The current model ignores bet amounts and check likelihoods. No coefficients were fitted.'])


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--sources', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    result = audit(json.loads(args.sources.read_text(encoding='utf-8')))
    result['sourceSha256'] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                              for name in ['range_calibration.py', 'opponent_model.py', 'public_replay.py', 'ranges.py']}
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps(dict(summary=result['summary'], byStreet=result['byStreet'])))


if __name__ == '__main__':
    main()
