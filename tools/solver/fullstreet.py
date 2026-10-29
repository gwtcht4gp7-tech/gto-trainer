"""Deadline-bounded multiplayer search, with full sampled betting continuations."""
from collections import defaultdict
from dataclasses import replace
import math
import os
import random
import time
import numpy as np
from mccfr import Blueprint, OutcomeSampling, Interrupted, pick
from nlhe import State, clockwise, EPS
from opponent_model import estimated_range
from ranges import parse_card

STREETS = {'preflop': 0, 'flop': 1, 'turn': 2, 'river': 3}


class IncompleteState(ValueError):
    pass


class Root:
    def __init__(self, req, deadline, cancel=None):
        self.deadline, self.cancel = deadline, cancel
        self.rng = np.random.default_rng(int(req.get('seed') or 20261027))
        self.random = random.Random(int(req.get('seed') or 20261027))
        self.board = tuple(parse_card(c) for c in req['board'])
        self.hero_cards = tuple(sorted(parse_card(c) for c in req['heroCards']))
        self.street = STREETS[req['street']]
        if len(self.board) != (0, 3, 4, 5)[self.street] or len(set(self.board + self.hero_cards)) != len(self.board) + 2:
            raise IncompleteState('手牌与公共牌不一致')
        if not req.get('historyComplete') or not req.get('playersContext'):
            raise IncompleteState('缺少完整公开行动或全部玩家投入信息')
        people = req['playersContext']
        dealer = next((i for i, p in enumerate(people) if p['seat'] == req.get('dealerSeat')), None)
        if dealer is None:
            raise IncompleteState('无法确定庄家及行动顺序')
        self.people = people[dealer:] + people[:dealer]
        self.n = len(self.people)
        if not 2 <= self.n <= 6:
            raise IncompleteState('当前模型支持 2–6 位起手玩家')
        ids = [str(p['id']) for p in self.people]
        if len(set(ids)) != self.n or str(req['heroId']) not in ids:
            raise IncompleteState('玩家 ID 不完整或重复')
        self.hero = ids.index(str(req['heroId']))
        index = {id_: i for i, id_ in enumerate(ids)}
        self.dealer = 0
        paid = [0.] * self.n
        current = [0.] * self.n
        acted = [-1.] * self.n
        previous_street = 0
        minimum = 1.
        tokens = []
        for a in req['history']:
            seat = index.get(str(a.get('playerId')))
            if seat is None:
                raise IncompleteState('行动记录中存在缺失玩家')
            street = STREETS[a['street']]
            if street > self.street:
                raise IncompleteState('快照落后于公开行动')
            if street != previous_street:
                current = [0.] * self.n; acted = [-1.] * self.n
                minimum = 1.
                previous_street = street
            label = a['action']
            previous_price = max(current)
            if label not in ('blind', 'ante', 'fold', 'check', 'call', 'bet', 'raise'):
                continue
            amount = float(a.get('amountBB', 0)) if label in ('blind', 'ante', 'call', 'bet', 'raise') else 0.
            if amount < -EPS or not math.isfinite(amount):
                raise IncompleteState('非法历史投入金额')
            if label in ('bet', 'raise'):
                call = max(current) - current[seat]
                ratio = (amount - call) / max(1., sum(paid) + call)
                label = ('raise' if call > EPS else 'bet') + ('50' if abs(ratio - .5) <= abs(ratio - 1) else '100')
                if a.get('moneyLeftBB') == 0:
                    label = 'allin'
            if a['action'] not in ('blind', 'ante'):
                tokens.append((street, seat, label))
            paid[seat] += amount
            live_amount = float(a.get('liveAmountBB') or 0) if a['action']=='ante' else amount
            if not math.isfinite(live_amount) or live_amount < -EPS or live_amount > amount+EPS:
                raise IncompleteState('非法强制下注抵扣金额')
            if a['action'] not in ('fold', 'check'):
                current[seat] += live_amount
            if a['action'] in ('bet', 'raise') and max(current)-previous_price >= minimum-EPS:
                minimum = max(current)-previous_price
            if a['action'] not in ('blind', 'ante', 'fold'):
                acted[seat] = max(current)
        tolerance = max(.005, 1 / max(1., float(req.get('bbChips') or 1000)))
        if abs(sum(paid) - float(req['pot'])) > tolerance:
            raise IncompleteState('底池与整手投入不一致，不能可靠分配主池/边池')
        stacks = tuple(float(p['stackBB']) for p in self.people)
        bets = tuple(float(p.get('wagerBB', 0)) for p in self.people)
        if not all(math.isfinite(x) and x >= 0 for x in stacks + bets):
            raise IncompleteState('非法筹码或在桌下注')
        folded = tuple(bool(p.get('folded')) for p in self.people)
        if folded[self.hero] or sum(not f for f in folded) < 2:
            raise IncompleteState('英雄已弃牌或无需决策')
        price = max(1., max(bets)) if self.street == 0 else max(bets)
        needed = max(0., price - bets[self.hero])
        to_call = float(req.get('toCall') or 0)
        if min(abs(needed-to_call), abs(min(needed, stacks[self.hero])-to_call)) > tolerance:
            raise IncompleteState('跟注额与在桌下注不一致')
        if previous_street != self.street:
            acted = [-1.] * self.n
            current = [0.] * self.n
            minimum = 1.
        if any(not folded[i] and abs(current[i]-bets[i]) > tolerance for i in range(self.n)):
            raise IncompleteState('当前街在桌下注与行动账本不一致')
        pending = tuple(i for i in [self.hero] + clockwise(self.n, self.hero)[:-1]
                        if not folded[i] and stacks[i] > EPS and
                        (i == self.hero or acted[i] < 0 or bets[i] < price - EPS))
        self.template = State(stacks, tuple(paid), bets, folded, self.dealer, self.street,
                              pending, price, max(minimum, float(req.get('minRaiseBB') or 1)),
                              tuple(acted), self.street == 0 or price >= 1., self.board,
                              (), (), tuple(tokens), exact_root_player=self.hero, exact_root_depth=len(tokens))
        self.ranges = []
        for p in self.people:
            self.check()
            arr, weights = estimated_range(p, req['history'], list(self.board))
            self.ranges.append((arr, weights.astype(np.float64) / weights.sum(dtype=np.float64)))
        hero_arr, hw = self.ranges[self.hero]
        hit = np.where((hero_arr == self.hero_cards).all(axis=1))[0]
        self.hero_index = int(hit[0])
        self.hero_probability = float(hw[self.hero_index])
        self.pool, self.fixed_pool = [], []

    def check(self):
        if time.perf_counter() >= self.deadline or self.cancel is not None and self.cancel.is_set():
            raise Interrupted()

    def deal(self, fixed_hero=False):
        self.check()
        pool = self.fixed_pool if fixed_hero else self.pool
        while not pool:
            self.check()
            count = 128
            chosen = [arr[self.rng.choice(len(arr), count, p=weights)] for arr, weights in self.ranges]
            if fixed_hero:
                chosen[self.hero][:] = self.hero_cards
            else:
                # Focus some deals on the requested hand, with importance correction.
                focus = self.rng.random(count) < .3
                chosen[self.hero][focus] = self.hero_cards
            holes = np.stack(chosen, axis=1)
            flat = np.sort(holes.reshape(count, -1), axis=1)
            valid = (np.diff(flat, axis=1) != 0).all(axis=1)
            for h in holes[valid]:
                exact = tuple(int(x) for x in h[self.hero]) == self.hero_cards
                weight = 1. if fixed_hero else self.hero_probability / (.7*self.hero_probability + .3) if exact else 1/.7
                pool.append((tuple(tuple(int(c) for c in pair) for pair in h), weight))
        holes, weight = pool.pop()
        used = set(self.board)
        used.update(c for pair in holes for c in pair)
        runout = self.board + tuple(self.random.sample([c for c in range(52) if c not in used], 5-len(self.board)))
        return replace(self.template, holes=holes, runout=runout), weight


def rollout(state, store, rng, deadline, cancel, coverage=None):
    for _ in range(200):
        if state.terminal:
            return state.returns()
        if time.perf_counter() >= deadline or cancel is not None and cancel.is_set():
            raise Interrupted()
        actions = state.actions()
        key = state.info_key(actions)
        info = store.get(key, len(actions))
        if coverage is not None and len(actions) > 1:
            visits = max(info.visits, store.prior_visits.get(key, 0))
            coverage['decisions'] += 1
            coverage['untrained'] += int(visits == 0)
            coverage['underSampled'] += int(visits < 8)
        state = state.step(actions[pick(info.mean_policy(), rng)])
    raise ValueError('Unexpected rollout depth')


def policy_quality(actions, values, frequencies, root_visits, coverage):
    """Operational rejection checks, not a convergence or strength certificate."""
    reasons = []
    samples = len(values[0]) if values else 0
    if root_visits < 8 or not frequencies:
        reasons.append('root_sample_shortage')
    if samples < 64:
        reasons.append('ev_sample_shortage')
    if coverage['underSampled']:
        reasons.append('unsupported_continuations')
    paired = {}
    if samples > 1:
        matrix = np.asarray(values, dtype=float).T
        means = matrix.mean(axis=0)
        mixed = matrix @ np.asarray([frequencies.get(a.label, 0.) for a in actions])
        leader = int(means.argmax())
        differences = matrix[:, leader] - mixed
        se = float(differences.std(ddof=1)/math.sqrt(samples))
        gap = float(differences.mean())
        paired = {'gapBB': gap, 'standardErrorBB': se}
        if frequencies and gap > max(.05, 2*se):
            reasons.append('policy_value_disagreement')
        # Check/fold on every future opportunity is a feasible continuation.
        # An estimate well below its loss bound is not an optimized action value.
        for i, action in enumerate(actions):
            error = float(matrix[:, i].std(ddof=1)/math.sqrt(samples))
            if action.label in ('check', 'call') and means[i]+2*error < -action.amount-.05:
                reasons.append('worse_than_check_fold_baseline')
                break
    return {'ready': not reasons, 'reasons': reasons, 'pairedPolicyGap': paired,
            'continuationCoverage': coverage}


def analyze_full(req, cancel=None):
    started = time.perf_counter()
    budget = min(3100., max(100., float(req.get('timeBudgetMs') or 2900)))
    if req.get('deadlineEpochMs'):
        budget = min(budget, max(0., float(req['deadlineEpochMs']) - time.time()*1000 - 100))
    deadline = started + budget/1000
    root = Root(req, deadline, cancel)
    store = Blueprint(os.environ.get('POKER_BLUEPRINT'), readonly=True, limit=30000)
    search = OutcomeSampling(store, int(req.get('seed') or 20261027))
    state, _ = root.deal(fixed_hero=True)
    actions = state.actions()
    key = state.info_key(actions)
    store.fallback_keys[key] = state.info_key(actions, exact=False)
    root_info = store.get(key, len(actions))
    training_deadline = deadline - min(.65, budget/1000*.25)
    cancelled = False
    values = [[] for _ in actions]
    coverage = {'decisions': 0, 'untrained': 0, 'underSampled': 0}
    try:
        while time.perf_counter() < training_deadline:
            sampled, weight = root.deal()
            active = [i for i in range(root.n) if not sampled.folded[i] and sampled.stacks[i] > EPS]
            updater = active[search.episodes % len(active)]
            try:
                search.episode(sampled, updater, training_deadline, cancel, chance_weight=weight)
            except Interrupted:
                break
        while time.perf_counter() < deadline and len(values[0]) < 256:
            sampled, _ = root.deal(fixed_hero=True)
            # Complete paired action samples only; incomplete batches are discarded.
            seed = search.rng.randrange(2**32)
            batch_coverage = {'decisions': 0, 'untrained': 0, 'underSampled': 0}
            batch = [rollout(sampled.step(action), store, random.Random(seed), deadline, cancel, batch_coverage)[root.hero]
                     + sampled.committed[root.hero] for action in actions]
            for array, value in zip(values, batch):
                array.append(value)
            for k in coverage:
                coverage[k] += batch_coverage[k]
    except Interrupted:
        cancelled = cancel is not None and cancel.is_set()
    finally:
        elapsed = (time.perf_counter()-started)*1000
    if cancelled:
        store.close()
        return {'ok': False, 'cancelled': True, 'error': '决策已过期，搜索取消', 'totalMs': elapsed}
    evs, errors = {}, {}
    for action, samples in zip(actions, values):
        if samples:
            evs[action.label] = float(np.mean(samples))
            errors[action.label] = float(np.std(samples, ddof=1)/math.sqrt(len(samples))) if len(samples)>1 else None
    frequencies = dict(zip((a.label for a in actions), root_info.mean_policy())) if root_info.visits >= 8 or store.prior_visits.get(key, 0) >= 8 else {}
    best = max(evs, key=evs.get) if evs else None
    quality = policy_quality(actions, values, frequencies,
                             max(root_info.visits, store.prior_visits.get(key, 0)), coverage)
    recommendation = max(frequencies, key=frequencies.get) if frequencies and quality['ready'] else None
    out = {'ok': True, 'model': 'multiplayer_fullstreet_mccfr_approx',
           'solver': 'outcome-sampling MCCFR + full betting continuations + SQLite blueprint',
           'street': req['street'], 'numPlayers': sum(not x for x in state.folded),
           'originalPlayers': root.n, 'frequencies': frequencies, 'evs': evs, 'evStandardErrors': errors,
           'evSamplesPerAction': len(values[0]), 'evUnit': 'bb', 'bestAction': recommendation,
           'bestEv': evs.get(recommendation), 'diagnosticEvLeader': best,
           'iterations': search.episodes, 'rootLocalVisits': root_info.visits,
           'recommendation': recommendation, 'recommendationReady': quality['ready'],
           'recommendationBasis': 'mixed_policy' if recommendation else None,
           'quality': quality, 'evDiagnosticOnly': not quality['ready'],
           'rootBlueprintVisits': store.prior_visits.get(key, 0), 'warmStartInfoSets': store.hits,
           'rootBlueprintSource': store.prior_source.get(key, 'none'),
           'informationSets': len(store.nodes), 'streetsVisited': search.street_visits,
           'historyActions': len(req['history']), 'historyComplete': True,
           'budgetMs': budget, 'totalMs': round(elapsed, 1), 'confidence': 'low',
           'actionAmounts': {a.label: {'additionalBB': a.amount, 'raiseToBB': a.amount + state.bets[root.hero]} for a in actions},
           'approx': ['多人自我对弈近似；每条抽样续局包含后续下注，直至弃牌结束或河牌摊牌，并分配主池/边池。',
                      '采用手牌与下注尺度抽象（半池、满池、有效全下），未证明收敛到完整多人纳什均衡。',
                      'EV 是抽样续局估计；标准误不包含对手范围、抽象与策略尚未收敛的误差。']}
    if not quality['ready']:
        out['approx'].append('续局覆盖、样本或可行策略下界未通过核对；本次频率和 EV 仅作诊断，不输出下注建议。')
    if coverage['decisions']:
        out['approx'].append('验证续局决策 %d 次，其中未训练 %d 次、少于 8 次训练 %d 次。' %
                             (coverage['decisions'], coverage['untrained'], coverage['underSampled']))
    if not frequencies:
        out['approx'].append('当前信息集训练样本不足 8 次，暂不显示行动混合比例；候选 EV 仍有较大不确定性。')
    if store.prior_source.get(key) == 'bucket':
        out['approx'].append('初始策略来自粗手牌桶蓝图；本次对实际两张手牌单独更新，避免把同类手牌混合比例直接套用。')
    if not evs:
        out['approx'].append('预算内未完成完整的候选动作比较，不输出猜测的最优动作。')
    if evs and frequencies:
        mixed_ev = sum(frequencies.get(a, 0)*v for a,v in evs.items())
        gap = max(evs.values())-mixed_ev
        out['localPolicyGapBB'] = round(gap, 3)
        out['policyUnstable'] = gap > max(1., 2*max((s or 0 for s in errors.values()), default=0))
        if out['policyUnstable']:
            out['approx'].append('当前混合比例与抽样动作 EV 差异较大，搜索尚不稳定；勿把该比例当作已收敛策略。')
    if not quality['ready']:
        out['diagnostics'] = {k: out[k] for k in ('frequencies', 'evs', 'evStandardErrors')}
        # Old clients also fail closed instead of turning diagnostic EV into a bet.
        out.update(frequencies={}, evs={}, evStandardErrors={})
    store.close()
    return out
