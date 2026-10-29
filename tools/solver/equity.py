"""范围 vs 范围的权益矩阵。"""
import numpy as np

from eval7 import eval7


def _masks(combos):
    return (np.int64(1) << combos[:, 0]) | (np.int64(1) << combos[:, 1])


def equity_matrix(hero, vill, board, samples=0, seed=7):
    """返回 (eq, hmask, vmask)。

    eq[i][j] = 英雄 combo i 对对手 combo j 的权益（0..1）。
    互斥的两手牌（共用一张牌）记 0.5，等价于"不存在"。
    """
    hero = np.asarray(hero, np.int64).reshape(-1, 2)
    vill = np.asarray(vill, np.int64).reshape(-1, 2)
    board = np.asarray(board, np.int64).reshape(-1)
    nH, nV = len(hero), len(vill)
    hmask, vmask = _masks(hero), _masks(vill)

    need = 5 - len(board)
    dead = set(int(x) for x in board)
    conflict = (hmask[:, None] & vmask[None, :]) != 0

    if need <= 0:
        ch = np.hstack([hero, np.tile(board, (nH, 1))])
        cv = np.hstack([vill, np.tile(board, (nV, 1))])
        rh, rv = eval7(ch), eval7(cv)
        eq = (rh[:, None] > rv[None, :]).astype(np.float32) + \
             0.5 * (rh[:, None] == rv[None, :]).astype(np.float32)
        eq[conflict] = 0.5
        return eq, hmask, vmask

    deck = np.array([c for c in range(52) if c not in dead], np.int64)
    if need == 1 and samples <= 0:
        runouts = [[int(c)] for c in deck]
    else:
        k = samples or 320
        rng = np.random.default_rng(seed)
        runouts = [rng.choice(deck, need, replace=False).tolist() for _ in range(k)]

    acc = np.zeros((nH, nV), np.float32)
    cnt = np.zeros((nH, nV), np.float32)
    for ro in runouts:
        full = np.concatenate([board, np.asarray(ro, np.int64)])
        ch = np.hstack([hero, np.tile(full, (nH, 1))])
        cv = np.hstack([vill, np.tile(full, (nV, 1))])
        rh, rv = eval7(ch), eval7(cv)
        rm = np.int64(0)
        for c in ro:
            rm |= np.int64(1) << np.int64(c)
        okh = (hmask & rm) == 0
        okv = (vmask & rm) == 0
        m = okh[:, None] & okv[None, :]
        contrib = (rh[:, None] > rv[None, :]).astype(np.float32) + \
                  0.5 * (rh[:, None] == rv[None, :]).astype(np.float32)
        acc += contrib * m
        cnt += m

    eq = np.full((nH, nV), 0.5, np.float32)
    ok = cnt > 0
    eq[ok] = acc[ok] / cnt[ok]
    eq[conflict] = 0.5
    return eq, hmask, vmask


def strength(combos, board, samples=260, seed=11):
    """每个 combo 对随机手牌的权益，用于范围缩窄与排序。"""
    combos = np.asarray(combos, np.int64).reshape(-1, 2)
    n = len(combos)
    need = 5 - len(board)
    dead = set(int(x) for x in board) | set(int(x) for x in combos.reshape(-1))
    deck = np.array([c for c in range(52) if c not in dead], np.int64)
    if len(deck) < need + 2:
        return np.full(n, 0.5, np.float32)
    rng = np.random.default_rng(seed)
    out = np.zeros(n, np.float64)
    for _ in range(samples):
        ro = rng.choice(deck, need + 2, replace=False)
        full = np.concatenate([np.asarray(board, np.int64), ro[:need]])
        ch = np.hstack([combos, np.tile(full, (n, 1))])
        rv = eval7(np.array([[ro[need], ro[need + 1]] + full.tolist()]))[0]
        rh = eval7(ch)
        out += (rh > rv).astype(np.float64) + 0.5 * (rh == rv).astype(np.float64)
    return (out / samples).astype(np.float32)
