"""翻后 CFR solver（CFR+ / 线性平均 / 机会牌抽样）。

树的根 = 当前决策点（英雄行动）。之后按公共动作树展开，
每条街结束后用机会节点抽样下一张公共牌。

记账约定
--------
pot0 : 根节点时的底池，已扣掉对手本街的下注（= 实时底池 - toCall）
inv  : 从根节点开始的累计投入 [英雄, 对手]，初始 [0, toCall]
因此任何时刻的底池 = pot0 + inv[0] + inv[1]，
终局净收益 = 权益 × 底池 - 自己的累计投入。

单位：底池与筹码都用 bb。
"""
import time

import numpy as np

# 节点类型
T_TERM, T_CHANCE, T_DEC = 0, 1, 2


class Node:
    __slots__ = ('kind', 'player', 'labels', 'children', 'weights', 'cards',
                 'regret', 'stratsum', 'term_type', 'pot_total', 'inv0', 'inv1',
                 'winner', 'nact', 'cache_it', 'cache_strat', 'depth', 'eq',
                 'buf', 'acc', 'action_amounts')

    def __init__(self, kind):
        self.kind = kind
        self.player = -1
        self.labels = None
        self.children = None
        self.weights = None
        self.cards = None
        self.regret = None
        self.stratsum = None
        self.term_type = -1
        self.pot_total = 0.0
        self.inv0 = 0.0
        self.inv1 = 0.0
        self.winner = -1
        self.nact = 0
        self.cache_it = -1
        self.cache_strat = None
        self.depth = 0
        self.eq = None
        self.action_amounts = None
        # 迭代期复用的缓冲区：buf = 当前行动方各动作的值 (n, nA)，
        # acc = 另一方的累计值 (n_other,)。避免每轮 np.stack 分配。
        self.buf = None
        self.acc = None


class Config:
    def __init__(self, sizes=None, max_raises=1, chance_turn=3, chance_river=3,
                 max_level=2):
        self.sizes = sizes or {0: [0.5, 1.0], 1: [0.7, 1.2], 2: [0.8]}
        self.max_raises = max_raises
        self.chance_turn = chance_turn    # flop -> turn 抽样张数
        self.chance_river = chance_river  # turn -> river 抽样张数
        self.max_level = max_level        # 求解到第几条街（0=只解翻牌）
        self.min_raise = 1.0
        self.max_nodes = 4000


class TreeTooBig(ValueError):
    pass


def stratified_pick(board, k, rng):
    """Uniform public-card sampling; blockers are handled in the traversal."""
    deck = [c for c in range(52) if c not in board]
    return [int(c) for c in rng.choice(deck, min(k, len(deck)), replace=False)]


class Builder:
    def __init__(self, cfg, nH, nV, hero_oop, rng, eq_provider=None):
        self.cfg = cfg
        self.nH = nH
        self.nV = nV
        self.hero_oop = hero_oop
        self.rng = rng
        self.eq_provider = eq_provider
        self.count = 0
        self.pick_cache = {}     # 同一 public board 上的机会牌必须一致，
                                 # 否则每个街末分支会各抽一套牌，权益矩阵被重复计算

    def street_starter(self):
        return 0 if self.hero_oop else 1

    def end_street(self, level, board, pot0, inv, stk, depth, eq=None):
        pot_total = pot0 + inv[0] + inv[1]
        if level >= 2 or level >= self.cfg.max_level or min(stk) <= 1e-9:
            n = Node(T_TERM)
            n.term_type = 0
            n.pot_total = pot_total
            n.inv0 = inv[0]
            n.inv1 = inv[1]
            n.eq = eq
            self.count += 1
            return n
        return self.chance(level + 1, board, pot0, inv, stk, depth)

    def chance(self, level, board, pot0, inv, stk, depth):
        cfg = self.cfg
        k = cfg.chance_turn if level == 1 else cfg.chance_river
        deck = [c for c in range(52) if c not in board]
        k = max(1, min(k, len(deck)))
        key = (level, tuple(board))
        cards = self.pick_cache.get(key)
        if cards is None:
            cards = stratified_pick(board, k, self.rng)
            self.pick_cache[key] = cards
        node = Node(T_CHANCE)
        node.cards = cards
        node.weights = [len(deck) / (len(deck) - 4) / k] * k
        kids = []
        for c in cards:
            nb = board + [c]
            sub_eq = None
            if self.eq_provider is not None:
                sub_eq = self.eq_provider(nb)
            kids.append(self.decision(level, nb, pot0, list(inv), stk,
                                      self.street_starter(), 0.0, 0, False,
                                      depth + 1, sub_eq))
        node.children = kids
        return node

    def decision(self, level, board, pot0, inv, stk, actor, to_call, raises, checked,
                 depth, eq=None, min_raise=None):
        cfg = self.cfg
        if self.count >= cfg.max_nodes or depth > 24:
            raise TreeTooBig('树规模超过预算，未返回未经验证的降级策略')
        cur_pot = pot0 + inv[0] + inv[1]
        avail = stk[actor]
        callable_bet = min(avail, stk[1 - actor])
        min_raise = self.cfg.min_raise if min_raise is None else min_raise
        labels, kids, amounts = [], [], []

        def emit(label, child, amount=0.):
            labels.append(label)
            kids.append(child)
            amounts.append(amount)

        if to_call <= 1e-9:
            if checked:
                emit('check', self.end_street(level, board, pot0, list(inv), stk, depth, eq))
            else:
                emit('check', self.decision(level, board, pot0, list(inv), list(stk),
                                            1 - actor, 0.0, raises, True, depth + 1, eq, min_raise))
            seen = set()
            for sz in cfg.sizes[level]:
                amt = min(max(1., round(sz * cur_pot, 2)), callable_bet)
                if amt <= 1e-9 or amt in seen:
                    continue
                seen.add(amt)
                ninv = list(inv)
                ninv[actor] += amt
                nstk = list(stk)
                nstk[actor] = round(nstk[actor] - amt, 4)
                lab = 'allin' if amt >= callable_bet - 1e-9 else 'bet%02d' % round(sz * 100)
                emit(lab, self.decision(level, board, pot0, ninv, nstk, 1 - actor,
                                        amt, raises + 1, False, depth + 1, eq, amt), amt)
            if callable_bet > 1e-9 and all(abs(callable_bet - s) > 1e-9 for s in seen):
                ninv = list(inv)
                ninv[actor] += callable_bet
                nstk = list(stk)
                nstk[actor] -= callable_bet
                emit('allin', self.decision(level, board, pot0, ninv, nstk, 1 - actor,
                                            callable_bet, raises + 1, False, depth + 1, eq, callable_bet), callable_bet)
        else:
            emit('fold', self._fold(pot0, inv, 1 - actor))
            pay = min(to_call, avail)
            ninv = list(inv)
            ninv[actor] += pay
            nstk = list(stk)
            nstk[actor] = round(nstk[actor] - pay, 4)
            # Refund the unmatched part of a short all-in call.
            refund = to_call - pay
            ninv[1 - actor] -= refund
            nstk[1 - actor] += refund
            emit('call', self.end_street(level, board, pot0, ninv, nstk, depth, eq), pay)
            if raises < cfg.max_raises and avail > pay + 1e-9:
                rest = min(avail - pay, stk[1 - actor])
                for sz in cfg.sizes[level]:
                    add = min(round(sz * (cur_pot + pay), 2), rest)
                    if add <= 1e-9 or (add < min_raise and add < rest - 1e-9):
                        continue
                    ninv2 = list(inv)
                    ninv2[actor] += pay + add
                    nstk2 = list(stk)
                    nstk2[actor] = round(nstk2[actor] - pay - add, 4)
                    lab = 'allin' if add >= rest - 1e-9 else 'raise%02d' % round(sz * 100)
                    emit(lab, self.decision(level, board, pot0, ninv2, nstk2, 1 - actor,
                                            add, raises + 1, False, depth + 1, eq, max(add, min_raise)), pay + add)

        node = Node(T_DEC)
        node.player = actor
        node.labels = labels
        node.children = kids
        node.action_amounts = amounts
        n = self.nH if actor == 0 else self.nV
        m = self.nV if actor == 0 else self.nH
        node.regret = np.zeros((n, len(labels)), np.float32)
        node.stratsum = np.zeros((n, len(labels)), np.float32)
        node.buf = np.empty((n, len(labels)), np.float32)
        node.acc = np.empty(m, np.float32)
        node.nact = len(labels)
        node.depth = depth
        self.count += 1
        return node

    def _fold(self, pot0, inv, winner):
        n = Node(T_TERM)
        n.term_type = 1
        n.pot_total = pot0 + inv[0] + inv[1]
        n.inv0 = inv[0]
        n.inv1 = inv[1]
        n.winner = winner
        self.count += 1
        return n


def build_street_start(cfg, nH, nV, board, level, pot_start, stk, hero_oop, rng,
                       eq_provider=None):
    """从本街开始建树（未有人下注），OOP 先行动。

    这样对手的下注范围由 solver 自己算出，不需要人为裁剪范围。
    """
    b = Builder(cfg, nH, nV, hero_oop, rng, eq_provider)
    oop = 0 if hero_oop else 1
    root = b.decision(level, list(board), pot_start, [0.0, 0.0], list(stk), oop,
                      0.0, 0, False, 0)
    return root, b.count


def navigate(root, path):
    """沿公共动作路径走到目标节点；走不通返回 None。"""
    node = root
    for lab in path:
        if node is None or node.kind != T_DEC or lab not in node.labels:
            return None
        node = node.children[node.labels.index(lab)]
    return node


def build_root(cfg, nH, nV, board, level, pot, stk, to_call, raises, checked,
               hero_oop, rng, eq_provider=None):
    """root 是英雄的决策节点。

    pot    : 当前底池（含本街已下的注）
    to_call: 英雄需要跟注的额
    raises : 本街已经发生的加注次数
    checked: 本街是否已经有人过牌
    """
    b = Builder(cfg, nH, nV, hero_oop, rng, eq_provider)
    pot0 = max(0.0, pot - to_call)
    inv = [0.0, float(to_call)]
    root = b.decision(level, list(board), pot0, inv, list(stk), 0, to_call, raises,
                      checked, 0)
    return root, b.count


# ---------------------------------------------------------------------------
# CFR+
# ---------------------------------------------------------------------------

_AVG = [False]        # 求解结束后切换到平均策略
_C_AVG = -2           # 平均策略的缓存标记（与迭代策略缓存互斥）


def avg_strategy(node):
    """平均策略：求解结束后的唯一读策略入口。

    注意：绝不能用「当轮迭代策略」输出结论——单次迭代的策略在震荡，
    平均策略才与 EV 自洽（regret matching 的收敛对象就是平均策略）。
    """
    if node.cache_it == _C_AVG and node.cache_strat is not None:
        return node.cache_strat
    st = node.stratsum
    shape = (node.regret.shape[0], node.nact) if node.regret is not None \
        else (0, node.nact)
    out = np.full(shape, 1.0 / node.nact, dtype=np.float32) if shape[0] else \
        np.zeros(shape, np.float32)
    if st is not None and shape[0]:
        tot = st.sum(axis=1, keepdims=True)
        m = tot[:, 0] > 1e-12
        if m.any():
            out[m] = st[m] / tot[m]
    node.cache_it = _C_AVG
    node.cache_strat = out
    return out


def _strategy(node, it):
    """训练期策略（regret matching）。求解后一律走 avg_strategy。"""
    if _AVG[0] or it is None:
        return avg_strategy(node)
    if node.cache_it == it and node.cache_strat is not None:
        return node.cache_strat
    r = node.regret
    s = r.sum(axis=1)
    np.maximum(s, 1e-12, out=s)          # 全零行（无可比信息）→ 均匀策略
    out = r * (1.0 / s)[:, None]
    unif = s < 2e-12
    if unif.any():
        out[unif] = 1.0 / node.nact
    node.cache_it = it
    node.cache_strat = out
    return out


def _walk(node, r0, r1, ctx, it, upd):
    k = node.kind
    if k == T_TERM:
        legal = ctx['legal']
        mass1, mass0 = legal @ r1, legal.T @ r0
        if node.term_type == 0:
            eq = node.eq if node.eq is not None else ctx['eq']
            win = eq * legal
            u0 = (win @ r1) * node.pot_total - node.inv0 * mass1
            u1 = ((legal - win).T @ r0) * node.pot_total - node.inv1 * mass0
            return u0, u1
        if node.winner == 0:
            return ((node.pot_total - node.inv0) * mass1, -node.inv1 * mass0)
        return (-node.inv0 * mass1, (node.pot_total - node.inv1) * mass0)

    if k == T_CHANCE:
        u0 = np.zeros(r0.shape, np.float32)
        u1 = np.zeros(r1.shape, np.float32)
        hm, vm = ctx['hmask'], ctx['vmask']
        for w, child, card in zip(node.weights, node.children, node.cards):
            bit = np.int64(1) << np.int64(card)
            okh = (hm & bit) == 0
            okv = (vm & bit) == 0
            a, b = _walk(child, r0 * okh, r1 * okv, ctx, it, upd)
            u0 += w * a * okh
            u1 += w * b * okv
        return u0, u1

    strat = _strategy(node, it)
    nact = node.nact
    if node.player == 0:
        M0 = node.buf                     # (nH, nA) 各动作的值，原地写
        A1 = node.acc                     # (nV,) 对手累计值
        A1.fill(0.0)
        for a in range(nact):
            a0, a1 = _walk(node.children[a], r0 * strat[:, a], r1, ctx, it, upd)
            M0[:, a] = a0
            A1 += a1
        u0 = np.einsum('na,na->n', strat, M0)
        if upd == 0:
            node.regret += M0 - u0[:, None]
            np.maximum(node.regret, 0, out=node.regret)
            node.stratsum += (it * r0)[:, None] * strat
        return u0, A1

    M1 = node.buf
    A0 = node.acc
    A0.fill(0.0)
    for a in range(nact):
        a0, a1 = _walk(node.children[a], r0, r1 * strat[:, a], ctx, it, upd)
        M1[:, a] = a1
        A0 += a0
    u1 = np.einsum('na,na->n', strat, M1)
    if upd == 1:
        node.regret += M1 - u1[:, None]
        np.maximum(node.regret, 0, out=node.regret)
        node.stratsum += (it * r1)[:, None] * strat
    return A0, u1


def context(eq, hmask, vmask):
    return {'eq': eq, 'hmask': hmask, 'vmask': vmask,
            'legal': ((hmask[:, None] & vmask[None, :]) == 0).astype(np.float32)}


def prior(weights, n):
    return np.ones(n, np.float32) if weights is None else np.asarray(weights, np.float32)


def solve(root, eq, hmask, vmask, iterations=400, time_budget=None, start_it=0,
          hero_weights=None, villain_weights=None):
    """CFR+ 求解。start_it>0 表示在已有 regret 上继续（线性平均的权重接续）。"""
    eq = np.ascontiguousarray(eq, dtype=np.float32)
    ctx = context(eq, hmask, vmask)
    r0 = prior(hero_weights, hmask.shape[0])
    r1 = prior(villain_weights, vmask.shape[0])
    _AVG[0] = False
    t0 = time.time()
    used = 0
    for k in range(1, iterations + 1):
        it = start_it + k
        # 交替更新（CFR+ 的收敛前提）：每轮只更新一方，
        # 同步更新会让双方同时「过冲」，实测会把 raise 分支的
        # 平均策略压在 0% 而它的 EV 仍高于 call，互相打脸。
        _walk(root, r0, r1, ctx, it, it & 1)
        used = k
        # Finish a complete CFR iteration; do not leave half-updated regrets.
        if time_budget and (time.time() - t0) * 1000 > time_budget:
            break
    _AVG[0] = True          # 之后读策略一律走平均策略
    return {'iterations': used, 'lastIt': start_it + used,
            'elapsedMs': (time.time() - t0) * 1000}


def average_strategy(node, out, path=()):
    if node.kind == T_DEC:
        s = node.stratsum
        tot = s.sum(axis=1, keepdims=True)
        avg = np.full(s.shape, 1.0 / node.nact, np.float32)
        m = tot[:, 0] > 1e-12
        if m.any():
            avg[m] = s[m] / tot[m]
        out.append((path, node.player, node.labels, avg))
        for lab, ch in zip(node.labels, node.children):
            average_strategy(ch, out, path + (lab,))
    elif node.kind == T_CHANCE:
        for card, ch in zip(node.cards, node.children):
            average_strategy(ch, out, path + ('|%d' % card,))


def root_action_evs(root, eq, hmask, vmask, hero_idx, hero_weights=None, villain_weights=None):
    """均衡策略下，英雄特定 combo 在根节点各动作的 EV（按对手范围加权）。"""
    eq = np.ascontiguousarray(eq, dtype=np.float32)
    ctx = context(eq, hmask, vmask)
    nH, nV = hmask.shape[0], vmask.shape[0]
    r0 = prior(hero_weights, nH)
    r1 = prior(villain_weights, nV)
    strat = avg_strategy(root)
    evs = []
    for a in range(root.nact):
        u0, _ = _walk(root.children[a], r0 * strat[:, a], r1, ctx, None, -1)
        arr = np.asarray(u0, dtype=np.float64)
        val = float(arr) if arr.ndim == 0 else float(arr[hero_idx])
        evs.append(val / max(1e-12, float(ctx['legal'][hero_idx] @ r1)))
    return evs


def node_action_evs(target, root, path, eq, hmask, vmask, hero_idx,
                    hero_weights=None, villain_weights=None):
    """目标节点上英雄各动作的 EV（bb），按对手在该节点的 reach 归一化。"""
    eq = np.ascontiguousarray(eq, dtype=np.float32)
    ctx = context(eq, hmask, vmask)
    nH, nV = hmask.shape[0], vmask.shape[0]
    r0 = prior(hero_weights, nH)
    r1 = prior(villain_weights, nV)
    node = root
    for lab in path:
        i = node.labels.index(lab)
        strat = avg_strategy(node)
        if node.player == 0:
            r0 = r0 * strat[:, i]
        else:
            r1 = r1 * strat[:, i]
        node = node.children[i]
    strat = avg_strategy(node)
    total = float(ctx['legal'][hero_idx] @ r1)
    if total < 1e-9:
        total = 1.0
    evs = []
    for a in range(node.nact):
        u0, _ = _walk(node.children[a], r0 * strat[:, a], r1, ctx, None, -1)
        arr = np.asarray(u0, dtype=np.float64)
        val = float(arr) if arr.ndim == 0 else float(arr[hero_idx])
        evs.append(val / total)
    return evs
