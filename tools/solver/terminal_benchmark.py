"""Frozen, finite river all-in call/fold benchmarks. Not general poker strength.

Ranges are priors, not observed opponent hole cards. A separate JavaScript
evaluator enumerates legal joint deals as reference. Actual joint_equity is
sampled before held-out outcomes are consulted. All opponents are all-in for
the same total; hero's call closes action and there are no side pots.
"""
import argparse
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import subprocess
import time

import numpy as np
from opponent_model import joint_equity
from ranges import card_str, parse_card

ROOT = Path(__file__).resolve().parents[2]


def generate_cases(seed=20261028, count=48):
    """Freeze every generated case; never filter by advantage or disagreement."""
    rng = np.random.default_rng(seed)
    cases = []
    for i in range(count):
        players = (2, 3, 5, 6)[i % 4]
        deal = rng.choice(52, 5 + players * 2, replace=False)
        board, hero = list(map(int, deal[:5])), list(map(int, deal[5:7]))
        possible = [c for c in range(52) if c not in board]
        cost = float((1, 5, 20, 50)[(i // 4) % 4])
        opponents = []
        for j in range(players - 1):
            # An anchor joint deal ensures at least one mutually legal outcome.
            combos = [sorted(map(int, deal[7 + j*2:9 + j*2]))]
            while len(combos) < 4:
                pair = sorted(map(int, rng.choice(possible, 2, replace=False)))
                if pair not in combos:
                    combos.append(pair)
            weights = [1., 1., 1., 1.] if (i // 4) % 2 else [1., 2., 4., 8.]
            opponents.append({'id': 'v%d' % j, 'committedBB': cost, 'stackBB': 0.,
                              'range': [{'cards': [card_str(c) for c in pair], 'weight': weight}
                                        for pair, weight in zip(combos, weights)]})
        dead = float((0, 2, 10)[(i // 16) % 3])
        cases.append({'id': 'generated-%03d' % i, 'group': 'generated',
                      'board': [card_str(c) for c in board], 'heroCards': [card_str(c) for c in hero],
                      'heroCommittedBB': 0., 'heroStackBB': cost + 100., 'toCallBB': cost,
                      'deadPotBB': dead, 'potBB': cost * (players - 1) + dead,
                      'referenceOpponent': i % (players - 1), 'opponents': opponents})
    return cases


def stress_cases():
    """Analytic near-threshold cases, reported separately from the frozen cohort."""
    cases = []
    for label, strong_weight in [('below', 1.01), ('equal', 1.), ('above', .99)]:
        cases.append({'id': 'stress-' + label, 'group': 'stress',
                      'board': ['As', 'Kd', '7h', '3c', '2s'], 'heroCards': ['Ac', 'Ad'],
                      'heroCommittedBB': 0., 'heroStackBB': 100., 'toCallBB': 20.,
                      'deadPotBB': 0., 'potBB': 40., 'referenceOpponent': 0,
                      'opponents': [
                          {'id': 'v0', 'committedBB': 20., 'stackBB': 0., 'range': [
                              {'cards': ['Ks', 'Kc'], 'weight': 1.},
                              {'cards': ['5c', '4c'], 'weight': strong_weight}]},
                          {'id': 'v1', 'committedBB': 20., 'stackBB': 0., 'range': [
                              {'cards': ['Qh', 'Qc'], 'weight': 1.},
                              {'cards': ['5c', '4c'], 'weight': strong_weight}]}]})
    return cases


def parse_case(case):
    board = [parse_card(c) for c in case['board']]
    hero = [parse_card(c) for c in case['heroCards']]
    if len(board) != 5 or len(hero) != 2 or len(set(board + hero)) != 7:
        raise ValueError('Benchmark requires a valid river and two hero cards')
    opp = case['opponents']
    if not 1 <= len(opp) <= 5 or len({p['id'] for p in opp}) != len(opp):
        raise ValueError('Invalid opponent count or IDs')
    amounts = [case[k] for k in ('potBB', 'toCallBB', 'heroCommittedBB', 'heroStackBB', 'deadPotBB')]
    if any(type(x) not in (float, int) or not math.isfinite(x) or x < 0 for x in amounts):
        raise ValueError('Invalid pot, stack, call or dead money')
    pot, call, committed, stack, dead = amounts
    if call <= 0 or stack < call or pot <= 0:
        raise ValueError('Call must be positive and fully covered by hero')
    target = committed + call
    if any(p['stackBB'] != 0 or p['committedBB'] != target for p in opp):
        raise ValueError('Only equal-contribution all-in opponents are supported; no side pots')
    if abs(pot - dead - committed - sum(p['committedBB'] for p in opp)) > 1e-9:
        raise ValueError('Pot does not reconcile with declared contributions')
    ref = case['referenceOpponent']
    if type(ref) is not int or not 0 <= ref < len(opp):
        raise ValueError('Reference opponent must be frozen before evaluation')
    estimates = []
    for p in opp:
        arr = np.array([sorted(parse_card(c) for c in item['cards']) for item in p['range']], dtype=np.int64)
        w = np.array([item['weight'] for item in p['range']], dtype=float)
        if arr.ndim != 2 or arr.shape[1] != 2 or not np.isfinite(w).all() or (w < 0).any() or w.sum() <= 0:
            raise ValueError('Invalid weighted range')
        if (arr[:, 0] == arr[:, 1]).any() or len(set(map(tuple, arr))) != len(arr):
            raise ValueError('Repeated card or duplicate range combo')
        estimates.append((arr, w))
    return hero, board, estimates


def exact_reference(case, hero, board, estimates):
    """Enumerate product priors, reject entire conflicting deals, then normalize."""
    pairs = sorted({tuple(hero)} | {tuple(pair) for arr, _ in estimates for pair in arr
                                    if not set(pair) & set(board + hero)})
    request = [[int(c) for c in list(pair) + board] for pair in pairs]
    script = "const E=require('./engine/gto-engine');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(c=>E.eval7(c)))));"
    r = subprocess.run(['node', '-e', script], cwd=ROOT, input=json.dumps(request),
                       capture_output=True, text=True, encoding='utf-8', check=True, timeout=2)
    values = dict(zip(pairs, json.loads(r.stdout)))
    hero_value = values[tuple(hero)]
    shares, weights = [], []
    for choices in itertools.product(*(range(len(arr)) for arr, _ in estimates)):
        used = set(board + hero)
        score = [hero_value]
        weight = 1.
        for k, index in enumerate(choices):
            arr, w = estimates[k]
            pair = tuple(arr[index])
            if set(pair) & used or w[index] == 0:
                break
            used.update(pair)
            weight *= float(w[index])
            score.append(values[pair])
        else:
            best = max(score)
            shares.append((1. / score.count(best)) if hero_value == best else 0.)
            weights.append(weight)
    if not weights:
        raise ValueError('No mutually legal joint deals')
    w = np.asarray(weights, dtype=float)
    w /= w.sum()
    return np.asarray(shares), w


def benchmark_case(case, seeds, samples=4000, holdout=20000):
    hero, board, estimates = parse_case(case)
    exact_shares, weights = exact_reference(case, hero, board, estimates)
    pot, cost = case['potBB'], case['toCallBB']
    true_equity = float(exact_shares @ weights)
    true_call_ev = true_equity * (pot + cost) - cost
    # Held-out draws are independent of estimator seeds and shared by both policies.
    holdout_seed = int(hashlib.sha256((case['id'] + '-heldout-v1').encode()).hexdigest()[:16], 16)
    idx = np.random.default_rng(holdout_seed).choice(len(weights), holdout, p=weights)
    returns = exact_shares[idx] * (pot + cost) - cost
    rows = []
    for seed in seeds:
        start = time.perf_counter()
        mc = joint_equity(hero, board, case['opponents'], [], samples=samples, seed=seed,
                          compare_opponent=case['referenceOpponent'], range_estimates=estimates)
        decisions = [mc['headsUpReference']['equity'] * (pot + cost) > cost,
                     mc['heroEquity'] * (pot + cost) > cost]
        elapsed = (time.perf_counter() - start) * 1000
        chosen_ev = [true_call_ev if d else 0. for d in decisions]
        regret = [max(0., true_call_ev) - ev for ev in chosen_ev]
        difference = (int(decisions[1]) - int(decisions[0])) * returns
        gain = float(difference.mean())
        se = float(difference.std(ddof=1) / math.sqrt(holdout))
        rows.append({'seed': seed, 'headsUpAction': 'call' if decisions[0] else 'fold',
                     'jointAction': 'call' if decisions[1] else 'fold',
                     'headsUpEquity': mc['headsUpReference']['equity'], 'jointEquity': mc['heroEquity'],
                     'jointEquityStandardError': mc['standardError'],
                     'jointCallEV95Interval': [(mc['heroEquity'] - 1.96*mc['standardError'])*(pot+cost)-cost,
                                               (mc['heroEquity'] + 1.96*mc['standardError'])*(pot+cost)-cost],
                     'jointCallIsSamplingMarginal': abs(mc['heroEquity']*(pot+cost)-cost) <= 1.96*mc['standardError']*(pot+cost),
                     'headsUpRegretBB': regret[0], 'jointRegretBB': regret[1],
                     'exactPairedGainBB': chosen_ev[1] - chosen_ev[0],
                     'holdoutPairedGainBB': gain, 'holdoutPairedSE': se,
                     'holdoutPaired95Interval': [gain - 1.96 * se, gain + 1.96 * se],
                     'inProcessEstimateAndDecisionMs': elapsed,
                     'equity': mc})
    return {'caseId': case['id'], 'group': case['group'], 'players': len(estimates) + 1, 'toCallBB': cost,
            'legalDeals': len(weights), 'exactEquity': true_equity, 'exactCallEVBB': true_call_ev,
            'threshold': cost / (pot + cost), 'holdout': holdout, 'rows': rows}


def summarize(results):
    # One observation per scenario, not one per simulated hand or estimator seed.
    gains = np.array([np.mean([r['exactPairedGainBB'] for r in c['rows']]) for c in results])
    se = float(gains.std(ddof=1) / math.sqrt(len(gains))) if len(gains) > 1 else None
    return {'scenarios': len(results), 'policyRuns': sum(len(c['rows']) for c in results),
            'scenarioMeanExactPairedGainBB': float(gains.mean()),
            'scenarioClusterSE': se,
            'scenarioCluster95Interval': None if se is None else [float(gains.mean()) - 1.96*se, float(gains.mean()) + 1.96*se],
            'headsUpMeanRegretBB': float(np.mean([np.mean([r['headsUpRegretBB'] for r in c['rows']]) for c in results])),
            'jointMeanRegretBB': float(np.mean([np.mean([r['jointRegretBB'] for r in c['rows']]) for c in results])),
            'changedActionRuns': sum(r['headsUpAction'] != r['jointAction'] for c in results for r in c['rows']),
            'maxInProcessEstimateAndDecisionMs': max(r['inProcessEstimateAndDecisionMs'] for c in results for r in c['rows'])}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--cases', type=Path)
    ap.add_argument('--count', type=int, default=48)
    ap.add_argument('--samples', type=int, default=4000)
    ap.add_argument('--holdout', type=int, default=20000)
    ap.add_argument('--seeds', default='20261027,333,777')
    args = ap.parse_args()
    if args.count < 2 or args.samples < 100 or args.holdout < 100:
        ap.error('count >= 2, samples/holdout >= 100 required')
    cases = json.loads(args.cases.read_text(encoding='utf-8')) if args.cases else generate_cases(count=args.count) + stress_cases()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    frozen = args.out.with_name(args.out.stem + '-cases.json')
    frozen.write_text(json.dumps(cases, indent=2), encoding='utf-8')
    # Save the full, outcome-independent cohort before computing any reference EV.
    digest = hashlib.sha256(frozen.read_bytes()).hexdigest()
    seeds = [int(s) for s in args.seeds.split(',')]
    results = []
    for case in cases:
        results.append(benchmark_case(case, seeds, args.samples, args.holdout))
        print(json.dumps({'case': case['id'], 'players': results[-1]['players'],
                          'legalDeals': results[-1]['legalDeals']}), flush=True)
    sources = [Path(__file__), Path(__file__).with_name('opponent_model.py'),
               Path(__file__).with_name('eval7.py'), ROOT / 'engine/gto-engine.js']
    report = {'scope': 'Synthetic closed river all-in call/fold only; not full poker, real-player skill or live HTTP certification',
              'caseSha256': digest, 'caseGenerationSeed': None if args.cases else 20261028,
              'sourceSha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
              'seeds': seeds, 'samplesPerPolicy': args.samples,
              'notes': ['No scenarios are filtered by action changes or realized profit.',
                        'Policies are frozen before heldout payoff evaluation; opponent hole cards are never policy inputs.',
                        'Both policies use the same weighted joint distribution conditioned on all card conflicts.',
                        'CI is scenario-clustered for this generator only; card-level intervals describe conditional simulation noise.',
                        'This checks the importance of counting all opponents in a call/fold subproblem, not superiority of a full multiplayer solver.',
                        'Reported in-process estimation time excludes reference enumeration, HTTP, startup and bridge overhead.'],
              'results': results, 'summary': summarize([c for c in results if c['group'] == 'generated'])
                                           if any(c['group'] == 'generated' for c in results) else None,
              'byGroup': {group: summarize([c for c in results if c['group'] == group])
                          for group in sorted({c['group'] for c in results})},
              'byPlayers': {str(n): summarize([c for c in results if c['players'] == n])
                            for n in sorted({c['players'] for c in results})},
              'byCallBB': {str(cost): summarize([c for c in results if c['toCallBB'] == cost])
                           for cost in sorted({c['toCallBB'] for c in results})}}
    temp = args.out.with_suffix('.tmp')
    temp.write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temp, args.out)
    print(json.dumps(report['summary']), flush=True)


if __name__ == '__main__':
    main()
