"""Fit one fixed candidate on match 100; evaluate once on untouched match 101."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import tomllib

from opponent_model import estimated_range
from public_replay import prefixes
from ranges import parse_card
from range_calibration import log_score, summarize
from sized_range import event_name, fit, sized_range


def prepare(sources):
    prepared, rejected = [], []
    for source in sources:
        try:
            prepared.append((source, prefixes(source['content'])))
        except (ValueError, KeyError, TypeError, IndexError) as error:
            rejected.append(dict(name=source['name'], error=str(error)))
    return prepared, rejected


def records(prepared):
    result = []
    for _, rows in prepared:
        for row in rows:
            r, words = row['request'], row['observedAction'].split()
            if r['street'] == 'preflop':
                continue
            action = {'f': 'fold', 'cc': 'call' if r['toCall'] else 'check',
                      'cbr': 'raise' if r['toCall'] else 'bet'}[words[1]]
            amount = (float(words[2])/r['bbChips'] - r['heroWagerBB'] if words[1] == 'cbr' else
                      r['toCall'] if words[1] == 'cc' else 0.)
            result.append(([parse_card(c) for c in r['board']], [parse_card(c) for c in r['heroCards']],
                           event_name(action, amount, r['pot'], r['toCall'])))
    return result


def evaluate(prepared, model, estimator=sized_range):
    results = []
    for source, rows in prepared:
        labels = {}
        for action in tomllib.loads(source['content'])['actions']:
            words = action.split()
            if words[:2] == ['d', 'dh'] and '?' not in words[3]:
                labels[words[2]] = [parse_card(words[3][:2]), parse_card(words[3][2:])]
        for row in rows:
            req = row['request']
            board = [parse_card(c) for c in req['board']]
            dead = set(board + [parse_card(c) for c in req['heroCards']])
            for player in req['opponents']:
                start = time.perf_counter()
                # Labels are deliberately used only AFTER both public priors.
                old = estimated_range(player, req['history'], board)
                new = estimator(player, req['history'], board, model)
                elapsed = (time.perf_counter()-start)*1000
                if player['id'] not in labels:
                    continue
                a, b = (log_score(*p, labels[player['id']], dead) for p in (old, new))
                results.append(dict(hand=source['name'], step=row['prefixActionIndex'], street=req['street'],
                                    opponentId=player['id'], gainNats=b-a, baselineLogScore=a,
                                    candidateLogScore=b, bothPriorMs=elapsed))
    post = [r for r in results if r['street'] != 'preflop']
    summary = summarize(post) if post else None
    return dict(rows=results, allStreets=summarize(results), postflop=summary,
                byStreet={s: summarize([r for r in results if r['street'] == s])
                          for s in sorted({r['street'] for r in results})},
                maxBothPriorMs=max(r['bothPriorMs'] for r in results))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--train', type=Path, required=True)
    ap.add_argument('--heldout', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    training = json.loads(args.train.read_text(encoding='utf-8'))
    heldout = json.loads(args.heldout.read_text(encoding='utf-8'))
    if {s['url'] for s in training} & {s['url'] for s in heldout}:
        raise ValueError('Training/heldout sources overlap')
    train, train_reject = prepare(training)
    test, test_reject = prepare(heldout)
    model = fit(records(train))
    model['trainingSources'] = [dict(url=s['url'], sha256=hashlib.sha256(s['content'].encode()).hexdigest()) for s in training]
    frozen = args.out.with_name('sized-range-v1.json')
    # Freeze before looking at held-out scores; never refit using their labels.
    frozen.write_text(json.dumps(model, indent=2), encoding='utf-8')
    report = evaluate(test, model)
    post = report['postflop']
    report.update(scope='Independent-match conditional range density, not policy profitability',
                  trainHands=len(train), heldoutHands=len(test), trainingObservations=model['observations'],
                  rejections=dict(training=train_reject, heldout=test_reject),
                  modelSha256=hashlib.sha256(frozen.read_bytes()).hexdigest(),
                  trainingBundleSha256=hashlib.sha256(args.train.read_bytes()).hexdigest(),
                  heldoutBundleSha256=hashlib.sha256(args.heldout.read_bytes()).hexdigest(),
                  heldoutSources=[dict(name=s['name'], url=s['url'], sha256=hashlib.sha256(s['content'].encode()).hexdigest()) for s in heldout],
                  densityGate=bool(post and post['approximate95Interval'] and post['approximate95Interval'][0] > 0
                                   and report['allStreets']['meanHandGainNats'] >= 0),
                  deploymentApproved=False)
    args.out.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('rows', 'heldoutSources')}))


if __name__ == '__main__':
    main()
