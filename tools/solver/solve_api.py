"""History-conditioned advisory models. No claim of full-game Nash optimality."""
import time
import math
import os
from pathlib import Path
import numpy as np
import cfr
from equity import equity_matrix
from opponent_model import estimated_range, joint_equity
from ranges import parse_card

STREET_LEVEL = {'flop': 0, 'turn': 1, 'river': 2}


def analyze_legacy(req):
    t0 = time.time()
    board = [parse_card(c) for c in req['board']]
    hero_cards = [parse_card(c) for c in req['heroCards']]
    street = req['street']
    if len(hero_cards) != 2 or len(set(board + hero_cards)) != len(board) + 2:
        return {'ok': False, 'error': '重复或不完整的手牌'}
    if len(board) != {'preflop': 0, 'flop': 3, 'turn': 4, 'river': 5}.get(street):
        return {'ok': False, 'error': '街与公共牌数量不符'}
    pot, to_call = float(req['pot']), float(req.get('toCall') or 0)
    stack = float(req.get('heroStack', req.get('effectiveStack', 100)))
    if not all(math.isfinite(x) for x in (pot, to_call, stack)) or pot <= 0 or min(to_call, stack) < 0:
        return {'ok': False, 'error': '无效底池、跟注额或筹码'}
    if to_call > pot + 1e-6:
        return {'ok': False, 'error': '底池必须包含当前下注；不能猜测或补加底池'}
    count = int(req.get('numPlayers') or 2)
    if not 2 <= count <= 10:
        return {'ok': False, 'error': '不支持的入池人数'}
    history = req.get('history') or []
    hero = {'id': str(req.get('heroId', 'hero')), 'pos': req.get('heroPos', 'BTN')}
    opponents = req.get('opponents')
    if opponents is None:
        opponents = [{'id': 'opponent%d' % i, 'pos': req.get('villainPos') or 'BB',
                      'stackBB': float(req.get('effectiveStack', stack))} for i in range(count - 1)]
    if len(opponents) != count - 1:
        return {'ok': False, 'error': '对手列表与在局人数不符'}
    approx = ['范围由位置、整手公开行动和收缩后的玩家统计估计，不是已求解的均衡范围。']
    if not req.get('historyComplete', False):
        approx.append('本手从中途接入，缺少的早期行动不会被猜测。')
    common = {'ok': True, 'street': street, 'historyActions': len(history),
              'historyComplete': bool(req.get('historyComplete')), 'numPlayers': count,
              'profilesUsed': [{'id': p['id'], 'hands': (p.get('profile') or {}).get('hands', 0),
                                'sampleWeight': (p.get('profile') or {}).get('sampleWeight', 0)} for p in opponents],
              'approx': approx, 'confidence': 'low'}
    if count > 2 or street == 'preflop':
        mc = joint_equity(hero_cards, board, opponents, history,
                          samples=max(500, min(20000, int(req.get('samples') or 6000))))
        call = min(to_call, stack)
        common.update(mc)
        common.update({'model': 'multiway_equity' if count > 2 else 'preflop_equity',
                       'solver': 'joint-range Monte Carlo', 'frequencies': {}, 'evs': {},
                       'potOdds': None if req.get('hasSidePotRisk') or to_call > stack else call / (pot + call),
                       'callCheckdownEV': None,
                       'totalMs': round((time.time() - t0) * 1000, 1)})
        if not req.get('hasSidePotRisk') and to_call <= stack:
            common['callCheckdownEV'] = mc['heroEquity'] * (pot + call) - call
        approx.append('联合抽样所有对手且排除撞牌；权益包含平分底池。不输出多人均衡行动频率。')
        approx.append('跟注后直接摊牌 EV 仅假设所有人此后过牌；不含后续下注、弃牌率或边池分配。')
        if req.get('hasSidePotRisk'):
            approx.append('存在全下或不等额投入：边池尚未建模，不显示跟注赔率和 EV；牌力权益不能直接套用总池。')
        return common

    level = STREET_LEVEL[street]
    limit = max(24, min(140, int(req.get('maxCombos') or 100)))
    hero_arr, hw = estimated_range(hero, history, board, limit)
    vill_arr, vw = estimated_range(opponents[0], history, board, limit)
    # Keep the opponent range independent of the actual hero hand.
    target_cards = sorted(hero_cards)
    where = np.where((hero_arr == target_cards).all(axis=1))[0]
    if not len(where):
        full, fw = estimated_range(hero, history, board)
        i = np.where((full == target_cards).all(axis=1))[0][0]
        hero_arr = np.vstack((hero_arr, full[i])); hw = np.append(hw, fw[i])
        hero_idx = len(hero_arr) - 1
    else:
        hero_idx = int(where[0])
    eq, hm, vm = equity_matrix(hero_arr, vill_arr, board, samples=400 if level == 0 else 0)
    cfg = cfr.Config(sizes={0: [.55], 1: [.7], 2: [.85]}, max_raises=2, max_level=level)
    cfg.min_raise = max(1., float(req.get('minRaiseBB') or to_call or 1))
    opp_stack = float(opponents[0].get('stackBB', req.get('effectiveStack', stack)))
    if not math.isfinite(opp_stack) or opp_stack < 0:
        return {'ok': False, 'error': '无效对手剩余筹码'}
    root, nodes = cfr.build_root(cfg, len(hero_arr), len(vill_arr), board, level,
                               pot, [stack, opp_stack], to_call, 0,
                               bool(req.get('opponentChecked')), bool(req.get('heroIsOop')),
                               np.random.default_rng(20261027))
    iterations = max(32, min(5000, int(req.get('iterations') or 1000)))
    result = cfr.solve(root, eq, hm, vm, iterations=iterations,
                       time_budget=max(100, min(5000, int(req.get('timeBudgetMs') or 1200))),
                       hero_weights=hw, villain_weights=vw)
    strategy = cfr.avg_strategy(root)[hero_idx]
    evs = cfr.root_action_evs(root, eq, hm, vm, hero_idx, hw, vw)
    freq = {lab: float(strategy[i]) for i, lab in enumerate(root.labels)}
    gap = max(evs) - sum(freq[lab] * evs[i] for i, lab in enumerate(root.labels))
    legal = ((hm[hero_idx] & vm) == 0) * vw
    equity = float(eq[hero_idx] @ legal / legal.sum())
    best = int(np.argmax(evs))
    common.update({'model': 'heads_up_cfr_estimate', 'solver': 'CFR+ current-street abstraction',
                   'frequencies': freq, 'evs': dict(zip(root.labels, map(float, evs))), 'evUnit': 'bb',
                   'actionAmounts': {lab: {'additionalBB': root.action_amounts[i],
                                          'raiseToBB': root.action_amounts[i] + float(req.get('heroWagerBB', 0))}
                                     for i, lab in enumerate(root.labels)},
                   'bestAction': root.labels[best], 'bestEv': float(evs[best]),
                   'heroEquity': equity, 'regret': round(float(gap), 4),
                   'confidence': 'medium' if gap < .1 and result['iterations'] >= 600 else 'low',
                   'iterations': result['iterations'], 'treeNodes': nodes,
                   'heroCombos': len(hero_arr), 'villainCombos': len(vill_arr),
                   'solveMs': round(result['elapsedMs'], 1),
                   'totalMs': round((time.time() - t0) * 1000, 1)})
    approx.append('只求解当前街的有限下注树；后续公共牌通过摊牌权益积分，未展开后续街下注。非完整 GTO 解。')
    approx.append('EV 相对当前决策点；局部 EV 差不是全局可利用度，也不保证收敛或盈利。')
    return common


def analyze(req, cancel=None):
    if not req.get('fullStreet'):
        return analyze_legacy(req)
    from fullstreet import analyze_full, IncompleteState
    from mccfr import Interrupted
    if os.environ.get('POKER_PRIORITY'):
        path = Path(os.environ['POKER_PRIORITY'])
        temporary = path.with_suffix('.tmp')
        temporary.write_text(str(time.time()+5), encoding='utf-8')
        os.replace(temporary, path)
    try:
        return analyze_full(req, cancel)
    except IncompleteState as error:
        # Inconsistent accounting must not become a fabricated multiplayer policy.
        result = analyze_legacy({**req, 'samples': 1000, 'timeBudgetMs': 400})
        result['fallback'] = True
        result['fallbackReason'] = str(error)
        result.setdefault('approx', []).insert(0, '全街搜索已降级：' + str(error))
        return result
    except Interrupted:
        return {'ok': False, 'cancelled': bool(cancel and cancel.is_set()),
                'error': '决策已取消或剩余计算预算不足'}
