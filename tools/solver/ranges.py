"""范围解析与翻前范围表。

card 编码与 eval7 一致：card = rank * 4 + suit，rank 0..12 = 2..A。
"""
import numpy as np

RANKS = '23456789TJQKA'
SUITS = 'shdc'
RANK_IDX = {c: i for i, c in enumerate(RANKS)}
SUIT_IDX = {c: i for i, c in enumerate(SUITS)}


def parse_card(s):
    return RANK_IDX[s[0].upper()] * 4 + SUIT_IDX[s[1].lower()]


def card_str(c):
    return RANKS[c >> 2] + SUITS[c & 3]


def class_combos(cls):
    """把 'AA' / 'AKs' / 'AKo' 展开为具体 combo 列表 [(c1,c2), ...]。"""
    r1 = RANK_IDX[cls[0]]
    r2 = RANK_IDX[cls[1]]
    if r1 == r2:
        return [(r1 * 4 + s1, r1 * 4 + s2)
                for s1 in range(4) for s2 in range(s1 + 1, 4)]
    suited = len(cls) == 2 or cls[2] == 's'
    out = []
    if suited:
        for s in range(4):
            out.append((r1 * 4 + s, r2 * 4 + s))
    else:
        for s1 in range(4):
            for s2 in range(4):
                if s1 != s2:
                    out.append((r1 * 4 + s1, r2 * 4 + s2))
    return out


def _class_name(r1, r2, suited):
    if r1 == r2:
        return RANKS[r1] * 2
    hi, lo = (r1, r2) if r1 > r2 else (r2, r1)
    return RANKS[hi] + RANKS[lo] + ('s' if suited else 'o')


def expand(spec):
    """展开范围字符串，返回 169 类名的集合。"""
    out = set()
    for token in spec.replace(' ', '').split(','):
        if not token:
            continue
        if '+' in token:
            base = token[:-1]
            if len(base) == 2 and base[0] == base[1]:
                start = RANK_IDX[base[0]]
                for r in range(start, 13):
                    out.add(RANKS[r] * 2)
            elif len(base) == 3:
                r_hi = RANK_IDX[base[0]]
                r_lo = RANK_IDX[base[1]]
                suf = base[2]
                # 'A2s+' / 'K9o+'：固定高牌，低牌从 r_lo 升到 r_hi-1
                for r in range(r_lo, r_hi):
                    out.add(_class_name(r_hi, r, suf == 's'))
            continue
        if '-' in token:
            a, b = token.split('-')
            if len(a) == 2 and a[0] == a[1] and len(b) == 2 and b[0] == b[1]:
                # 对子区间：'22-77'
                lo, hi = sorted((RANK_IDX[a[0]], RANK_IDX[b[0]]))
                for r in range(lo, hi + 1):
                    out.add(RANKS[r] * 2)
                continue
            r_hi = RANK_IDX[a[0]]
            lo_a, lo_b = RANK_IDX[a[1]], RANK_IDX[b[1]]
            suf = a[2] if len(a) == 3 else ('s' if len(b) == 3 and b[2] == 's' else None)
            step = 1 if lo_b >= lo_a else -1
            for r in range(lo_a, lo_b + step, step):
                if suf == 's':
                    out.add(_class_name(r_hi, r, True))
                elif suf == 'o':
                    out.add(_class_name(r_hi, r, False))
                else:
                    out.add(_class_name(r_hi, r, True))
                    out.add(_class_name(r_hi, r, False))
            continue
        if len(token) == 2:
            r1, r2 = RANK_IDX[token[0]], RANK_IDX[token[1]]
            if r1 == r2:
                out.add(token[0] * 2)
            else:
                out.add(_class_name(r1, r2, True))
                out.add(_class_name(r1, r2, False))
        elif len(token) == 3:
            out.add(_class_name(RANK_IDX[token[0]], RANK_IDX[token[1]], token[2] == 's'))
    return out


def _cls_key(cls):
    """确定性排序键：高牌降序、低牌降序、同花优先。

    expand() 内部用 set 去重，而 Python 的字符串哈希每个进程都随机化，
    不排序的话 combos() 的顺序会在进程间漂移，[:maxCombos] 截断就会
    取到不同的牌，同一局面的 EV 能差好几个 bb。
    """
    hi = RANK_IDX[cls[0]]
    lo = RANK_IDX[cls[1]]
    if len(cls) == 2:
        suf = 0
    else:
        suf = 0 if cls[2] == 's' else 1
    return (-hi, -lo, suf)


def combos(spec, dead=()):
    """展开为具体 combo 数组 (n,2)，排除与 dead 冲突的组合。"""
    dead = set(int(x) for x in dead)
    out = []
    for cls in sorted(expand(spec), key=_cls_key):
        for c1, c2 in class_combos(cls):
            if c1 in dead or c2 in dead:
                continue
            out.append((c1, c2))
    return np.array(out, dtype=np.int64).reshape(-1, 2)


# ---------------------------------------------------------------------------
# 翻前范围表（6-max 基线，百分位来自常见 solver 输出的近似）
# ---------------------------------------------------------------------------

OPEN_RANGE = {
    'UTG': '22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,54s,ATo+,KJo+,QJo',
    'MP': '22+,A2s+,K8s+,Q9s+,J9s+,T8s+,97s+,86s+,75s+,65s,54s,ATo+,KTo+,QTo+,JTo',
    'CO': '22+,A2s+,K5s+,Q7s+,J8s+,T7s+,96s+,85s+,74s+,64s+,53s+,A2o+,KTo+,QTo+,JTo',
    'BTN': '22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,85s+,74s+,63s+,53s+,43s,A2o+,K9o+,Q9o+,J9o+,T8o+,98o,87o',
    'SB': '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,95s+,84s+,74s+,63s+,52s+,43s,A2o+,K8o+,Q8o+,J8o+,T8o+,98o,87o,76o',
    'BB': '22+,A2s+,K2s+,Q3s+,J5s+,T6s+,95s+,84s+,73s+,62s+,52s+,42s+,32s,A2o+,K5o+,Q7o+,J7o+,T7o+,97o+,86o+,75o+,65o,54o',
}

# 面对单次加注的跟注范围（按自己的位置）
CALL_VS_OPEN = {
    'BB': '22-77,A2s-A9s,K6s-KTs,Q7s-QJs,J7s-JTs,T7s-T9s,96s+,85s+,74s+,64s+,53s+,43s,A8o-AJo,K9o-KQo,Q9o-QJo,J9o,JTo,T9o,98o,87o',
    'SB': '22-88,A2s-A9s,K8s-KTs,Q8s-QJs,J8s-JTs,T8s-T9s,97s+,86s+,75s+,65s,54s,AJo-AQo,KQo,KJo,QJo',
    'BTN': '22-88,A2s-ATs,K9s-KJs,Q9s-QJs,J9s-JTs,T8s-T9s,98s,87s,76s,65s,AJo-ATo,KQo,KJo,QJo',
    'CO': '22-88,A2s-ATs,K8s-KQs,Q9s-QJs,J9s-JTs,T8s-T9s,98s,87s,AJo,AQo,KQo',
    'MP': '22-88,A2s-ATs,K8s-KJs,Q9s-QJs,J9s-JTs,T8s-T9s,98s,AJo,AQo,KQo',
    'UTG': '22-88,A2s-AJs,K9s-KQs,Q9s-QJs,J9s-JTs,T9s,98s,AJo,AQo,KQo',
}

THREE_BET_VS_OPEN = {
    'BB': 'QQ+,AKs,AKo,AQs,A5s,A4s,KQs,JJ',
    'SB': 'JJ+,AKs,AKo,AQs,A5s,KQs,AJs',
    'BTN': 'QQ+,AKs,AKo,AQs,A5s,A4s,KQs,ATs',
    'CO': 'QQ+,AKs,AKo,AQs,A5s,KQs',
    'MP': 'QQ+,AKs,AKo,AQs,KQs',
    'UTG': 'QQ+,AKs,AKo,AQs',
}


def open_range(pos):
    return OPEN_RANGE.get(pos, OPEN_RANGE['BTN'])


def call_range(pos):
    return CALL_VS_OPEN.get(pos, CALL_VS_OPEN['BB'])


def threebet_range(pos):
    return THREE_BET_VS_OPEN.get(pos, THREE_BET_VS_OPEN['BTN'])
