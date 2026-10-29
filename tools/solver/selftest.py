"""solver 自检：覆盖各街 + 关键局面的方向性检查。

用法：python selftest.py
判定标准（任何一条不满足就算失败）：
  1. 每个局面都能解出来（ok=True）
  2. 自洽性残差 regret <= 0.25bb（策略与 EV 不打架）
  3. 方向性符合牌理（空气弃牌 / 坚果价值下注 / 强听牌跟注 / 顶对不弃）
"""
import time

import solve_api

# (名称, 请求, 期望动作集合)
CASES = [
    ('空气牌面对满池下注（该弃）',
     dict(street='river', board=['As', 'Kd', 'Qc', '7s', '2h'], heroCards=['6h', '5h'],
          pot=40, toCall=20, effectiveStack=60, heroPos='BB', villainPos='BTN',
          preflopAggressor='villain', raises=1, heroIsOop=True), {'fold'}),
    ('顶对面对满池下注（该跟）',
     dict(street='river', board=['As', 'Kd', 'Qc', '7s', '2h'], heroCards=['Ah', '9h'],
          pot=40, toCall=20, effectiveStack=60, heroPos='BB', villainPos='BTN',
          preflopAggressor='villain', raises=1, heroIsOop=True), {'call', 'raise'}),
    ('坚果在河牌、对手过牌（该下注）',
     dict(street='river', board=['As', 'Kd', 'Qc', '7s', '2h'], heroCards=['Ad', 'Ac'],
          pot=20, toCall=0, effectiveStack=60, heroPos='BTN', villainPos='BB',
          preflopAggressor='hero', raises=1, heroIsOop=False), {'bet', 'allin'}),
    ('强听牌面对翻牌下注（该跟）',
     dict(street='flop', board=['Qh', '8h', '3c'], heroCards=['Jh', 'Th'],
          pot=12, toCall=4, effectiveStack=70, heroPos='BB', villainPos='BTN',
          preflopAggressor='villain', raises=1, heroIsOop=True), {'call', 'raise'}),
    ('底对面对翻牌小注（该跟）',
     dict(street='flop', board=['Ah', 'Kd', '7c'], heroCards=['7d', '6d'],
          pot=9, toCall=2, effectiveStack=70, heroPos='BB', villainPos='BTN',
          preflopAggressor='villain', raises=1, heroIsOop=True), {'call', 'raise'}),
    ('中等牌转牌无人下注（可过牌）',
     dict(street='turn', board=['Kd', '9c', '4h', '3s'], heroCards=['Kc', '5c'],
          pot=8, toCall=0, effectiveStack=60, heroPos='BTN', villainPos='BB',
          preflopAggressor='hero', raises=1, heroIsOop=False), {'check', 'bet70'}),
    ('顶对顶踢转牌无人下注（该下注）',
     dict(street='turn', board=['As', '7d', '2c', 'Qh'], heroCards=['Ah', 'Kh'],
          pot=12.5, toCall=0, effectiveStack=88, heroPos='BTN', villainPos='BB',
          preflopAggressor='hero', raises=1, heroIsOop=False), {'bet', 'allin'}),
    ('三人池翻牌坚果听牌（该跟或加）',
     dict(street='flop', board=['9h', '8h', '3c'], heroCards=['Jh', 'Th'],
          pot=14, toCall=5, effectiveStack=90, heroPos='CO', villainPos='BTN',
          preflopAggressor='hero', raises=1, heroIsOop=False, numPlayers=3),
     {'call', 'raise'}),
]


def cat_of(label):
    """把 'bet55' / 'raise85' / 'allin' 归到动作大类。"""
    for k in ('allin', 'fold', 'check', 'call'):
        if label == k:
            return k
    if label.startswith('bet'):
        return 'bet'
    if label.startswith('raise'):
        return 'raise'
    return label


def main():
    fails = 0
    print('%-28s %-5s %5s %5s %-6s %6s  %s' % ('局面', '街', '耗时', '迭代', '状态', '残差', '结论'))
    print('-' * 100)
    for name, req, expect in CASES:
        t = time.time()
        try:
            r = solve_api.analyze(req)
        except Exception as e:
            print('%-28s 异常 %r' % (name, e))
            fails += 1
            continue
        dt = (time.time() - t) * 1000
        if not r.get('ok'):
            print('%-28s 失败 %s' % (name, r.get('error')))
            fails += 1
            continue
        got = cat_of(r['bestAction'])
        ok = r['regret'] <= 0.25 and got in expect
        if not ok:
            fails += 1
        mix = '  '.join('%s %.0f%%' % (k, v * 100) for k, v in
                        sorted(r['frequencies'].items(), key=lambda kv: -kv[1]) if v > 0.01)
        print('%-28s %-5s %5.0f %5d %-6s %6.2f  %s %s'
              % (name, r['street'], dt, r['iterations'], r['confidence'], r['regret'],
                 '✓' if ok else '✗', mix))
        if not ok:
            print('      期望 %s，得到 %s（%s）' % (expect, got, r['bestAction']))
    print('\n%d/%d 通过' % (len(CASES) - fails, len(CASES)))
    return 1 if fails else 0


if __name__ == '__main__':
    raise SystemExit(main())
