"""向量化 7 张牌牌力评估（只依赖 numpy）。

card 编码：card = rank * 4 + suit，rank 0..12 对应 2..A，suit 0..3。
eval7 返回 int64 分数，越大越强；同分即平局。
"""
import numpy as np

# category（高 4 bit 之外的整数部分，越大越强）
HIGH_CARD, PAIR, TWO_PAIR, TRIPS, STRAIGHT, FLUSH, FULL_HOUSE, QUADS, STRAIGHT_FLUSH = range(9)


def _top5(mask):
    """从 13 bit 的 rank 掩码里取最大的 5 个 rank，编码为 20 bit。"""
    n = mask.shape[0]
    out = np.zeros(n, np.int64)
    cnt = np.zeros(n, np.int64)
    for r in range(12, -1, -1):
        has = ((mask >> r) & 1).astype(bool)
        take = has & (cnt < 5)
        out = np.where(take, (out << 4) | r, out)
        cnt = cnt + take
    return out


def _straight_high(mask):
    """mask: 13 bit（bit0 = 2 ... bit12 = A）。返回顺子最高 rank index，-1 表示没有。

    轮子（A2345）返回 3（5 的 index）。注意 A 不能同时占 bit12 和"低 A 位"，
    否则 KQJA 会被误判成连续五位。
    """
    n = mask.shape[0]
    hi = np.full(n, -1, np.int64)
    for top in range(4, 13):
        need = np.int64(0b11111) << (top - 4)
        hit = (mask & need) == need
        hi = np.where(hit, top, hi)
    wheel = ((mask & np.int64(0b1111)) == np.int64(0b1111)) & (((mask >> 12) & 1) == 1)
    hi = np.where(wheel & (hi < 3), 3, hi)
    return hi


def eval7(cards):
    """cards: (N, k) int 数组，k<=7（k<7 时按 7 张补全无意义，仅用于比较同花等子集）。

    返回 (N,) int64 分数。
    """
    cards = np.asarray(cards, dtype=np.int64)
    if cards.ndim == 1:
        cards = cards[None, :]
    n, k = cards.shape
    rank = cards >> 2
    suit = cards & 3

    ranks_all = np.arange(13)[None, None, :]
    rc = (rank[:, :, None] == ranks_all).sum(axis=1).astype(np.int64)

    sc = (suit[:, :, None] == np.arange(4)[None, None, :]).sum(axis=1).astype(np.int64)
    mask = np.bitwise_or.reduce(np.int64(1) << rank, axis=1)
    st = _straight_high(mask)

    smask = np.zeros((n, 4), np.int64)
    for s in range(4):
        smask[:, s] = np.bitwise_or.reduce(
            np.where(suit == s, np.int64(1) << rank, np.int64(0)), axis=1)

    fsuits = sc >= 5
    has_flush = fsuits.any(axis=1)
    fsu = np.where(has_flush, fsuits.argmax(axis=1), 0)
    fmask = smask[np.arange(n), fsu]
    sf = np.where(has_flush, _straight_high(fmask), -1)

    cnts = np.sort(rc, axis=1)[:, ::-1]
    c0 = cnts[:, 0]
    c1 = cnts[:, 1]

    cat = np.zeros(n, np.int64)
    cat = np.where(c0 >= 2, PAIR, cat)
    cat = np.where((c0 >= 2) & (c1 >= 2), TWO_PAIR, cat)
    cat = np.where(c0 >= 3, TRIPS, cat)
    cat = np.where(st >= 0, STRAIGHT, cat)
    cat = np.where(has_flush, FLUSH, cat)
    cat = np.where((c0 >= 3) & (c1 >= 2), FULL_HOUSE, cat)
    cat = np.where(c0 >= 4, QUADS, cat)
    cat = np.where(sf >= 0, STRAIGHT_FLUSH, cat)

    # Encode only ranks in the best five cards. Unused sixth/seventh cards
    # must never break ties (e.g. identical full houses on the board).
    ranks = np.arange(13)[None, :]

    def highest(valid):
        return np.sort(np.where(valid, ranks, -1), axis=1)[:, ::-1]

    def pack(*columns):
        out = np.zeros(n, np.int64)
        for i in range(5):
            out = (out << 4) | (np.maximum(columns[i], 0) if i < len(columns) else 0)
        return out

    pairs = highest(rc >= 2)
    trips = highest(rc >= 3)[:, 0]
    quads = highest(rc >= 4)[:, 0]
    singles = highest(rc == 1)
    two_kicker = highest((rc > 0) & (ranks != pairs[:, :1]) & (ranks != pairs[:, 1:2]))[:, 0]
    trip_kickers = highest((rc > 0) & (ranks != trips[:, None]))
    house_pair = highest((rc >= 2) & (ranks != trips[:, None]))[:, 0]
    quad_kicker = highest((rc > 0) & (ranks != quads[:, None]))[:, 0]
    t = _top5(mask)
    t = np.where(cat == PAIR, pack(pairs[:, 0], singles[:, 0], singles[:, 1], singles[:, 2]), t)
    t = np.where(cat == TWO_PAIR, pack(pairs[:, 0], pairs[:, 1], two_kicker), t)
    t = np.where(cat == TRIPS, pack(trips, trip_kickers[:, 0], trip_kickers[:, 1]), t)
    t = np.where(cat == STRAIGHT, pack(st), t)
    t = np.where(cat == FLUSH, _top5(fmask), t)
    t = np.where(cat == FULL_HOUSE, pack(trips, house_pair), t)
    t = np.where(cat == QUADS, pack(quads, quad_kicker), t)
    t = np.where(cat == STRAIGHT_FLUSH, pack(sf), t)

    return (cat << 20) | t


def evaluate_sets(cards_a, cards_b):
    """两组手牌各自评分，返回 (score_a, score_b)。"""
    return eval7(cards_a), eval7(cards_b)
