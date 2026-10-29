"""Post-hand analysis, separate from live service; yields to real-time leases."""
import argparse
from dataclasses import replace
import json
import math
from pathlib import Path
import random
import time
import numpy as np
from fullstreet import Root, IncompleteState, rollout, policy_quality
from mccfr import Blueprint, OutcomeSampling, Interrupted
from nlhe import Action, EPS


class RealtimePriority:
    def __init__(self, path):
        self.path = Path(path) if path else None
        self.checked, self.active = 0., False

    def is_set(self):
        now = time.monotonic()
        if now-self.checked >= .02:
            self.checked = now
            try:
                self.active = bool(self.path and float(self.path.read_text(encoding='utf-8')) > time.time())
            except (OSError, ValueError):
                self.active = False
        return self.active


def actual_action(state, record):
    actual, req = record['actual'], record['request']
    amount = actual.get('amount')
    if amount is None:
        raise IncompleteState('实际投入金额缺失')
    amount /= req['bbChips']
    legal = state.actions()
    if actual['action'] in ('fold', 'check', 'call'):
        match = next((a for a in legal if a.label == actual['action']), None)
        if match is None or abs(match.amount-amount) > max(.005, 1/req['bbChips']):
            raise IncompleteState('实际行动与记录局面不一致')
        return match
    if actual['action'] not in ('bet', 'raise') or not math.isfinite(amount):
        raise IncompleteState('不支持的实际行动')
    p = state.player
    call = max(0., state.price-state.bets[p])
    if amount <= call+EPS or amount > state.stacks[p]+EPS or not any(a.label not in ('fold','check','call') for a in legal):
        raise IncompleteState('实际下注不符合当前可行动范围')
    increment = amount+state.bets[p]-state.price
    if increment < state.min_raise-EPS and amount < state.stacks[p]-EPS:
        raise IncompleteState('实际加注低于最小加注且非全下')
    match = next((a for a in legal if a.label not in ('fold','check','call') and abs(a.amount-amount) <= EPS), None)
    return match or Action('actual@'+format(amount,'.8g'), amount)


def review_decision(record, model=None, budget_ms=8000, sample_limit=1024, cancel=None):
    started = time.perf_counter()
    deadline = started+budget_ms/1000
    req = {**record['request'], 'pot':record['request']['potBB'], 'toCall':record['request']['toCallBB']}
    root = Root(req, deadline, cancel)
    state, _ = root.deal(fixed_hero=True)
    actual = actual_action(state, record)
    if actual.label.startswith('actual@'):
        root.template = replace(root.template, extra_root_action=actual)
        state = replace(state, extra_root_action=actual)
    actions = state.actions()
    store = Blueprint(model, readonly=True, limit=30000)
    try:
        search = OutcomeSampling(store, int(req.get('seed') or 20261027))
        key = state.info_key(actions)
        store.fallback_keys[key] = state.info_key(actions, exact=False)
        info = store.get(key, len(actions))
        training_deadline = started+budget_ms/1000*.65
        while time.perf_counter() < training_deadline:
            deal, weight = root.deal()
            active = [i for i in range(root.n) if not deal.folded[i] and deal.stacks[i] > EPS]
            try:
                search.episode(deal, active[search.episodes % len(active)], training_deadline, cancel, chance_weight=weight)
            except Interrupted:
                break
        values = []
        coverage = {'decisions': 0, 'untrained': 0, 'underSampled': 0}
        try:
            while time.perf_counter() < deadline and len(values) < sample_limit:
                deal, _ = root.deal(fixed_hero=True)
                seed = search.rng.randrange(2**32)
                batch_coverage = {'decisions': 0, 'untrained': 0, 'underSampled': 0}
                batch = [rollout(deal.step(a), store, random.Random(seed), deadline, cancel, batch_coverage)[root.hero]
                         + deal.committed[root.hero] for a in actions]
                values.append(batch)
                for k in coverage:
                    coverage[k] += batch_coverage[k]
        except Interrupted:
            pass
        if cancel and cancel.is_set():
            raise Interrupted()
        if len(values) < 2:
            raise IncompleteState('预算内完整行动比较样本不足')
        matrix = np.asarray(values)
        means, errors = matrix.mean(axis=0), matrix.std(axis=0, ddof=1)/math.sqrt(len(values))
        best, selected = int(means.argmax()), next(i for i,a in enumerate(actions) if a.label==actual.label)
        differences = matrix[:,best]-matrix[:,selected]
        gap, error = float(differences.mean()), float(differences.std(ddof=1)/math.sqrt(len(values)))
        frequencies = dict(zip((a.label for a in actions), info.mean_policy())) if info.visits>=8 else {}
        quality = policy_quality(actions, matrix.T.tolist(), frequencies,
                                 max(info.visits, store.prior_visits.get(key, 0)), coverage)
        return {'kind':'posthand_review','decisionId':record['decisionId'],'handId':record['handId'],
                'at':time.time(),'status':'reviewed','model':'fullstreet_sampled_review',
                'actualLabel':actual.label,'actualAdditionalBB':actual.amount,
                'evs':dict(zip((a.label for a in actions), map(float,means))),
                'evStandardErrors':dict(zip((a.label for a in actions), map(float,errors))),
                'frequencies':frequencies, 'quality':quality,
                'samplesPerAction':len(values),'episodes':search.episodes,'rootVisits':info.visits,
                'comparison':{'estimatedGapBB':gap,'pairedStandardErrorBB':error,
                              'verdict':'unsupported_model' if not quality['ready'] else
                                'lower_estimated_ev' if gap>max(.1,2*error) else 'uncertain'},
                'totalMs':round((time.perf_counter()-started)*1000,1),
                'notes':['仅使用行动前信息；结算和摊牌底牌不作为行动时已知信息。',
                         '配对续局估计包含范围、抽象与未收敛误差；行动筛选也存在选择偏差，非严格置信证明。',
                         '真实净输赢用于审计，不作为 GTO 正确性标签。']}
    finally:
        store.close()


def records(path):
    if Path(path).exists():
        with open(path, encoding='utf-8-sig') as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue


def run(args):
    cancel = RealtimePriority(args.priority)
    previous=list(records(args.output))
    completed = {r['decisionId'] for r in previous if r.get('decisionId')}
    reviewed=sum(r.get('status')=='reviewed' for r in previous)
    excluded=sum(r.get('status')=='excluded' for r in previous)
    jobs, finished, offset, pending = {}, set(), 0, b''
    latest=next((r for r in reversed(previous) if r.get('status')=='reviewed'),None)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    def status(state):
        payload = {'status':state,'updatedAt':time.time(),'completed':reviewed,'excluded':excluded,
                   'queued':sum(j['handId'] in finished for k,j in jobs.items() if k not in completed),'latest':latest}
        p=Path(args.status); p.parent.mkdir(parents=True, exist_ok=True)
        tmp=p.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8');tmp.replace(p)
    while True:
        if cancel.is_set():
            status('paused_for_realtime');time.sleep(.25);continue
        source=Path(args.observations)
        if source.exists():
            if source.stat().st_size<offset:
                offset,pending=0,b''
            with source.open('rb') as f:
                f.seek(offset);pending+=f.read();offset=f.tell()
            lines=pending.split(b'\n');pending=lines.pop()
            for line in lines:
                try:r=json.loads(line)
                except ValueError:continue
                if r.get('kind')=='hand_result':finished.add(r['handId'])
                if r.get('kind')=='decision_action' and r['decisionId'] not in completed:jobs[r['decisionId']]=r
        ready=[j for j in jobs.values() if j['handId'] in finished and j['decisionId'] not in completed]
        if not ready:
            status('idle' if completed else 'waiting')
            if args.once:break
            time.sleep(1);continue
        job=max(ready,key=lambda j:(j.get('comparison',{}).get('status')=='off_menu',
                                   bool((j.get('analysis') or {}).get('policyUnstable')),j.get('at','')))
        status('reviewing')
        try:
            result=review_decision(job,args.model,args.budget_ms,cancel=cancel)
        except Interrupted:
            status('paused_for_realtime');time.sleep(.25);continue
        except (IncompleteState,ValueError,KeyError) as e:
            result={'kind':'posthand_review','decisionId':job['decisionId'],'handId':job['handId'],
                    'at':time.time(),'status':'excluded','reason':str(e)}
        with open(args.output,'a',encoding='utf-8') as f:f.write(json.dumps(result,ensure_ascii=False)+'\n')
        if result['status']=='reviewed' and result.get('quality',{}).get('ready') and args.priorities:
            with open(args.priorities,'a',encoding='utf-8') as f:
                f.write(json.dumps({'kind':'review_priority','request':job['request'],
                    'actual':job['actual'],'gapBB':result['comparison']['estimatedGapBB'],
                    'errorBB':result['comparison']['pairedStandardErrorBB']},ensure_ascii=False)+'\n')
        if result['status']=='reviewed':reviewed+=1
        else:excluded+=1
        completed.add(job['decisionId']);jobs.pop(job['decisionId'],None)
        if result['status']=='reviewed':latest=result
        status('idle');time.sleep(.35)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--observations',required=True);parser.add_argument('--output',required=True)
    parser.add_argument('--status',required=True);parser.add_argument('--model');parser.add_argument('--priority')
    parser.add_argument('--priorities');parser.add_argument('--budget-ms',type=float,default=8000)
    parser.add_argument('--once',action='store_true');run(parser.parse_args())
