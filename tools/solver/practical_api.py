"""Opt-in practical test release: heuristic + joint equity, no learned model."""
import time
from practical_replay import run_case

VERSION = '20261029-practical-test-v1'
REASONS = {
    'unresolved_pot_eligibility':'边池或可赢底池尚不能可靠核对。',
    'sampling_cannot_separate_call_and_fold':'跟注与弃牌的估计差异落在抽样误差内。',
    'sampling_interval_changes_heuristic_action':'抽样误差足以改变候选动作。',
    'invalid_or_ambiguous_commitment':'候选下注超过筹码或金额口径不明确。',
    'below_minimum_raise':'候选未满足最低加注额。',
    'raising_not_reopened':'本轮尚未重新开放加注。',
    'unvalidated_deep_commitment':'深筹码大额投入缺少可靠依据。',
    'free_check_available':'可以免费过牌，保留继续观察的机会。',
    'minimum_legal_size_enforced':'已将下注调整到最低合法额度。',
}


def analyze_practical(req, cancel=None):
    start = time.perf_counter()
    budget = 3100.
    if req.get('deadlineEpochMs'):
        budget = min(budget,float(req['deadlineEpochMs'])-time.time()*1000-100)
    if budget < 50:
        return dict(ok=False,error='本次决策已过期',version=VERSION)
    # Full immutable ledger determines eligibility; don't treat every all-in as
    # an automatic side pot. Actual short/unequal all-ins are checked by Root.
    public = dict(req)
    public.setdefault('heroStack',public.get('stackBB',public.get('effectiveStack')))
    if public.get('historyComplete') and public.get('playersContext'):
        public['hasSidePotRisk'] = False
    result = run_case(public,20261027,4000,budget,cancel=cancel)
    if result['status'] != 'ok':
        return dict(ok=False,cancelled=result['status']=='cancelled',version=VERSION,
                    error=result.get('error','本次决策已取消'),totalMs=result['wallMs'])
    preview = result['variants']['joint_equity_correction']['guardedPreview']
    ready, action = preview['ready'], preview['action']
    if action in ('3bet','4bet'):
        action = 'raise'
    approx = ['实用测试版：原启发式 + 所有活跃对手的联合权益，并非已求解的 GTO。',
              '范围使用整手公开行动、位置和收缩后的玩家统计；未启用新学习模型。',
              '标准误只描述抽样波动；对手范围与后续行动仍可能估错。']
    approx += [REASONS.get(r,r) for r in preview['reasons']]
    if result['street']=='preflop':
        approx.append('翻前动作来自简单范围模板；联合权益不决定翻前开池频率。')
    if preview.get('kind')=='closed_river_call_fold':
        approx.append('本次仅比较河牌跟注与弃牌，未比较加注收益。')
    raw=result['variants']['joint_equity_correction']['rawDecision']
    raw_reasons=raw.get('reasons') or []
    q,se=result['equity']['heroEquity'],result['equity']['standardError']
    call=min(public.get('toCall',0),public['heroStack'])
    price=call/(public['pot']+call)
    headline=raw_reasons[-1] if raw_reasons else '依据简单范围与牌面规则给出近似候选。'
    details=raw_reasons
    if preview['reasons']==['minimum_legal_size_enforced']:
        headline+=' '+REASONS['minimum_legal_size_enforced']
    elif preview['reasons'] or preview.get('kind')=='closed_river_call_fold':
        headline=' '.join(REASONS.get(r,r) for r in preview['reasons']) or ('河牌跟注后结束下注，按估计权益与当前价格比较跟注、弃牌。')
        details=[]  # A guarded replacement must not inherit the old action's rationale.
    own=str(req.get('heroId'))
    public_actions=[a for a in req.get('history',[]) if str(a.get('playerId'))!=own and a.get('action') not in ('blind','ante')]
    reasoning=dict(headline=headline,
        keyPoints=[{'label':'牌力估计','text':f"对 {result['numPlayers']-1} 位对手的联合权益约 {q:.1%}，抽样标准误 {se:.1%}。"},
                   {'label':'当前价格','text':f'跟注需要 {price:.1%} 权益；该门槛不包含后续下注风险。' if call else '当前无需跟注，可以选择免费过牌；主动下注是启发式选择。'},
                   {'label':'公开路线','text':f'已观察 {len(public_actions)} 条对手自愿行动，结合位置与玩家统计估计范围。'}],
        details=details,
        limitations=['翻前行动来自位置范围模板，联合权益仅供参考。'] if result['street']=='preflop' else
                    ['这是牌面/范围启发式，未验证下注 EV 或弃牌率。','下注尺度与过牌概率尚未精细建模。'])
    return dict(ok=True,version=VERSION,model='practical_heuristic_v1',testRelease=True,
                recommendationReady=ready,recommendation=action,quality={'reasons':[REASONS.get(r,r) for r in preview['reasons']]},
                actionAmounts={} if not ready else {action:dict(additionalBB=preview['additionalBB'],
                    raiseToBB=preview['additionalBB']+float(req.get('heroWagerBB',0)))},
                frequencies={},evs={},approx=approx,reasoning=reasoning,street=result['street'],
                heroEquity=result['equity']['heroEquity'],standardError=result['equity']['standardError'],
                samples=result['samples'],historyActions=result['historyActions'],
                historyComplete=result['historyComplete'],numPlayers=result['numPlayers'],
                profilesUsed=[{'id':p['id'],'hands':(p.get('profile') or {}).get('hands',0)} for p in req['opponents']],
                totalMs=round((time.perf_counter()-start)*1000,1),
                potOdds=None if result['sidePotRisk'] else min(public.get('toCall',0),public['heroStack'])/(public['pot']+min(public.get('toCall',0),public['heroStack'])),
                practicalKind=preview['kind'])
