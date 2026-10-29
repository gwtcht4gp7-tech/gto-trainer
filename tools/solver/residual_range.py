"""Five bounded public-action corrections to the original range prior.

Fit offline from dealt-card labels; inference has only public action history.
No strategy EV or full-game equilibrium claims.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import tomllib
import numpy as np

from opponent_model import estimated_range
from ranges import parse_card
from sized_range import buckets, history_context

VERSION = 'public-size-residual-v2'
FEATURES = ['aggression_size_strength', 'aggression_size_polarity', 'check_strength',
            'call_price_strength', 'aggression_size_flushdraw']


def features(player, history, arr):
    out = np.zeros((len(arr), 5))
    for pid, board, event, amount, pot, call in history_context(history):
        if pid != str(player['id']):
            continue
        bucket = buckets(arr, [parse_card(c) for c in board])
        q = (bucket//2 + .5)/5 - .5
        if event.startswith(('bet_', 'raise_')):
            size = np.log1p(min(10., max(0., amount-call)/max(pot+call, 1e-9)))
            out[:, 0] += size*q
            out[:, 1] += size*4*q*q
            out[:, 4] += size*(bucket % 2)
        elif event == 'check':
            out[:, 2] += q
        elif event.startswith('call_'):
            out[:, 3] += min(1., call/max(pot+call, 1e-9))*q
    return out


def residual_range(player, history, board, model):
    theta = np.asarray(model['theta'], dtype=float)
    if model.get('version') != VERSION or model.get('features') != FEATURES or theta.shape != (5,) or not np.isfinite(theta).all() or (np.abs(theta)>2).any():
        raise ValueError('Invalid residual range model')
    arr, weights = estimated_range(player, history, board)
    adjustment = features(player, history, arr) @ theta
    weights = weights.astype(float)*np.exp(np.clip(adjustment-adjustment.max(), -60, 0))
    weights /= weights.max()
    return arr, weights.astype(np.float32)


def training_examples(prepared):
    examples = []
    for source, rows in prepared:
        labels = {}
        for action in tomllib.loads(source['content'])['actions']:
            words = action.split()
            if words[:2] == ['d', 'dh'] and '?' not in words[3]:
                labels[words[2]] = sorted([parse_card(words[3][:2]), parse_card(words[3][2:])])
        for row in rows:
            req = row['request']
            if req['street'] == 'preflop':
                continue
            board = [parse_card(c) for c in req['board']]
            dead = board + [parse_card(c) for c in req['heroCards']]
            for player in req['opponents']:
                arr, w = estimated_range(player, req['history'], board)
                x = features(player, req['history'], arr)
                valid = ~np.isin(arr, dead).any(axis=1)
                arr, w, x = arr[valid], w[valid].astype(float), x[valid]
                if player['id'] not in labels:
                    continue
                hit = np.flatnonzero((np.sort(arr, axis=1) == labels[player['id']]).all(axis=1))
                if len(hit) != 1:
                    raise ValueError('Training label is not a legal unique combo')
                examples.append((source['name'], w/w.sum(), x, x[hit[0]]))
    counts = Counter(e[0] for e in examples)
    return [(w, x, target, 1/(counts[name]*len(counts))) for name, w, x, target in examples]


def objective(theta, examples):
    loss, gradient = .025*float(theta@theta), .05*theta.copy()
    for w, x, target, scale in examples:
        logits = x@theta
        shift = logits.max()
        p = w*np.exp(logits-shift)
        loss += scale*(np.log(p.sum())+shift-target@theta)
        p /= p.sum()
        gradient += scale*(p@x-target)
    return loss, gradient


def fit_residual(examples):
    theta, m, v = np.zeros(5), np.zeros(5), np.zeros(5)
    initial = objective(theta, examples)[0]
    for step in range(1, 161):
        _, g = objective(theta, examples)
        m, v = .9*m+.1*g, .999*v+.001*g*g
        theta = np.clip(theta-.05*(m/(1-.9**step))/(np.sqrt(v/(1-.999**step))+1e-8), -2, 2)
    return dict(version=VERSION, features=FEATURES, theta=theta.tolist(),
                trainingLabels=len(examples), initialObjective=initial,
                finalObjective=objective(theta, examples)[0], regularization=.05, steps=160)


def main():
    # PHH/PokerKit are training-only dependencies, not inference dependencies.
    from train_sized_range import prepare, evaluate
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--train', type=Path, required=True)
    ap.add_argument('--test', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    training = json.loads(args.train.read_text(encoding='utf-8'))
    testing = json.loads(args.test.read_text(encoding='utf-8'))
    if {s['url'] for s in training} & {s['url'] for s in testing}:
        raise ValueError('Training and test overlap')
    train, rejected_train = prepare(training)
    test, rejected_test = prepare(testing)
    model = fit_residual(training_examples(train))
    frozen = args.out.with_name('residual-range-v2.json')
    frozen.write_text(json.dumps(model, indent=2), encoding='utf-8')
    report = evaluate(test, model, residual_range)
    report.update(trainHands=len(train), testHands=len(test), model=model,
                  modelSha256=hashlib.sha256(frozen.read_bytes()).hexdigest(),
                  inputSha256={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (args.train,args.test)},
                  rejections=dict(train=rejected_train, test=rejected_test),
                  densityGate=report['postflop']['approximate95Interval'][0] > 0,
                  deploymentApproved=False)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k != 'rows'}))


if __name__ == '__main__':
    main()
