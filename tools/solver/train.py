"""Low-priority, resumable self-play. Pauses during real-time search leases."""
import argparse
import json
import os
from pathlib import Path
import random
import time
from mccfr import Blueprint, OutcomeSampling, Interrupted, VERSION
from nlhe import new_hand
from fullstreet import Root, IncompleteState
from dataclasses import replace
from review import actual_action


def run(args):
    store = Blueprint(args.model)
    if store.connection is None:
        raise RuntimeError('Cannot open blueprint database')
    search = OutcomeSampling(store)
    previous = store.connection.execute('SELECT value FROM meta WHERE key=?', ('episodes',)).fetchone()
    search.episodes = int(previous[0]) if previous else 0
    rng = random.Random(20261027 + search.episodes)
    started, saved, computation = time.monotonic(), 0., 0.
    factories = []
    cases_loaded_at = 0.

    def load_cases():
        lines = []
        if args.cases and Path(args.cases).exists():
            with open(args.cases, 'rb') as f:
                f.seek(max(0, Path(args.cases).stat().st_size-1000000))
                lines = f.read().decode('utf-8', errors='ignore').splitlines()
        candidates = []
        for line in reversed(lines):
            try:
                req = json.loads(line)
                if req.get('kind') != 'decision' or not req.get('playersContext'):
                    continue
                candidates.append({**req, 'pot':req['potBB'], 'toCall':req['toCallBB']})
                if len(candidates) >= 8: break
            except (ValueError, KeyError):
                continue
        if not candidates and args.seed_cases and Path(args.seed_cases).exists():
            candidates = json.loads(Path(args.seed_cases).read_text(encoding='utf-8'))[-8:]
        result = []
        if args.review_cases and Path(args.review_cases).exists():
            with open(args.review_cases, 'rb') as f:
                f.seek(max(0, Path(args.review_cases).stat().st_size-1000000))
                priority_rows = f.read().decode('utf-8', errors='ignore').splitlines()
            ranked = []
            for line in priority_rows:
                try:
                    r = json.loads(line)
                    ranked.append(r)
                except ValueError:
                    continue
            unique = set()
            for r in sorted(ranked, key=lambda x:abs(x.get('gapBB',0))+x.get('errorBB',0), reverse=True):
                try:
                    req=r['request']; key=(req['handId'],len(req['history']))
                    if key in unique:continue
                    req={**req,'pot':req['potBB'],'toCall':req['toCallBB']}
                    root=Root(req,float('inf'));sampled,_=root.deal(True)
                    action=actual_action(sampled,r)
                    if action.label.startswith('actual@'):
                        root.template=replace(root.template,extra_root_action=action)
                    result.append(root);unique.add(key)
                    if len(result)>=4:break
                except (IncompleteState,ValueError,KeyError):
                    continue
        for req in candidates:
            try: result.append(Root(req, float('inf')))
            except (IncompleteState, ValueError, KeyError): pass
        return result
    status_path = Path(args.status)
    status_path.parent.mkdir(parents=True, exist_ok=True)

    def status(state):
        count = store.connection.execute('SELECT count(*) FROM policy').fetchone()[0]
        payload = {'version': VERSION, 'status': state, 'episodes': search.episodes,
                   'pid': os.getpid(),
                   'storedInformationSets': count, 'cachedInformationSets': len(store.nodes),
                   'trainingSecondsThisRun': round(computation, 2),
                   'streetVisitsThisRun': search.street_visits, 'updatedAt': time.time(),
                   'observedSubgames': len(factories), 'capacity': args.max_infosets,
                   'modelFile': str(Path(args.model).resolve()),
                   'notes': 'Self-play abstraction; no full-game Nash certificate.'}
        temporary = status_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload, indent=2), encoding='utf-8')
        os.replace(temporary, status_path)
        return count

    status('starting')
    try:
        while not args.seconds or time.monotonic()-started < args.seconds:
            if args.stop and Path(args.stop).exists():
                break
            priority = 0.
            if args.priority and Path(args.priority).exists():
                try:
                    priority = float(Path(args.priority).read_text(encoding='utf-8'))
                except (ValueError, OSError):
                    pass
            if priority > time.time():
                if time.monotonic()-saved > 2:
                    status('paused_for_realtime'); saved = time.monotonic()
                time.sleep(.15)
                continue
            if time.monotonic()-cases_loaded_at > 15:
                factories = load_cases(); cases_loaded_at = time.monotonic()
            batch_start = time.perf_counter()
            deadline = batch_start + .15
            while time.perf_counter() < deadline:
                weight = 1.
                if factories and rng.random() < .5:
                    state, weight = rng.choice(factories).deal()
                    active = [i for i in range(state.n) if not state.folded[i] and state.stacks[i] > 0]
                    if not active:continue
                    updater = active[search.episodes % len(active)]
                else:
                    n = rng.choice([2, 3, 4, 5, 5, 6, 6])
                    depth = rng.choice([20., 50., 100., 300., 1000., 3000.])
                    stacks = tuple(depth * rng.choice([.5, 1., 1., 2.]) for _ in range(n))
                    cards = rng.sample(range(52), n*2+5)
                    holes = [tuple(sorted(cards[i*2:i*2+2])) for i in range(n)]
                    state = new_hand(stacks, 0, holes, cards[n*2:])
                    updater = search.episodes % n
                try:
                    search.episode(state, updater, deadline, chance_weight=weight)
                except Interrupted:
                    break
            computation += time.perf_counter()-batch_start
            if time.monotonic()-saved > 2 or len(store.nodes) >= store.limit*.9:
                store.checkpoint(search.episodes)
                count = status('training' if store.allow_new else 'training_at_capacity'); saved = time.monotonic()
                store.allow_new = count < args.max_infosets
                if len(store.nodes) >= store.limit*.9:
                    store.nodes.clear(); store.dirty.clear()
            time.sleep(.35)
    finally:
        store.checkpoint(search.episodes)
        status('stopped')
        store.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--status', required=True)
    parser.add_argument('--priority')
    parser.add_argument('--stop')
    parser.add_argument('--cases')
    parser.add_argument('--seed-cases')
    parser.add_argument('--review-cases')
    parser.add_argument('--seconds', type=float, default=0)
    parser.add_argument('--max-infosets', type=int, default=1000000)
    run(parser.parse_args())
