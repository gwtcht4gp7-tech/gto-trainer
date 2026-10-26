/*!
 * gto-engine.js — 零依赖 GTO 基线决策引擎
 * ---------------------------------------------------------------
 * 输入一份 hand state（JSON），输出一个可解释的决策建议。
 *
 * 它是什么：一个把 GTO 基线规则编码成代码的「启发式引擎」。
 *           数学部分（牌型、权益、底池赔率、MDF）是精确的；
 *           策略部分（频率、尺度）是 solver 输出的近似拟合。
 *
 * 它不是什么：不是 solver，不做树搜索，不求解纳什均衡。
 *           它给出的是「方向正确、量级正确」的建议，用于教学。
 *
 * 用法（浏览器）：
 *   <script src="engine/gto-engine.js"></script>
 *   const r = GTOEngine.advise({ street:'flop', ... });
 *
 * 用法（Node）：
 *   const GTO = require('./engine/gto-engine.js');
 *   const r = GTO.advise({ ... });
 * ---------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTOEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 0. 常量与牌的工具函数
   * ================================================================ */

  // 手牌等级：0=2 ... 12=A
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANK_VAL = {};
  RANKS.forEach((r, i) => { RANK_VAL[r] = i; });
  // 牌面展示用的花色符号
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

  /** "As" -> 0..51（rank*4 + suit）；无法解析返回 -1 */
  function parseCard(s) {
    if (typeof s !== 'string' || s.length !== 2) return -1;
    const r = RANK_VAL[s[0].toUpperCase()];
    const su = SUITS.indexOf(s[1].toLowerCase());
    if (r === undefined || su < 0) return -1;
    return r * 4 + su;
  }

  /** 0..51 -> "As" */
  function cardStr(c) {
    return RANKS[c >> 2] + SUITS[c & 3];
  }

  /** 花色符号版："As" -> "A♠" */
  function cardPretty(c) {
    const s = typeof c === 'string' ? c : cardStr(c);
    return s[0] + (SUIT_SYM[s[1]] || s[1]);
  }

  /** 解析 "As Kh 7d" / "AsKh7d" / ["As","Kh"] -> [0..51]，非法项被丢弃 */
  function parseCards(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
      return input.map(c => (typeof c === 'number' ? c : parseCard(String(c)))).filter(c => c >= 0 && c < 52);
    }
    const str = String(input).replace(/[^A-Za-z0-9]/g, '');
    const out = [];
    for (let i = 0; i + 1 < str.length; i += 2) {
      const c = parseCard(str.substr(i, 2));
      if (c >= 0) out.push(c);
    }
    return out;
  }

  /* ================================================================
   * 1. 范围解析
   *    支持 22+ / A2s+ / ATo+ / KQo / AK（不写花色 = s+o 两者）
   * ================================================================ */

  /** 展开范围字符串 -> Set<"AA"|"AKs"|"AKo"> */
  function expandRange(str) {
    const set = new Set();
    if (!str) return set;
    if (/^(all|random|\*)$/i.test(String(str).trim())) {
      for (let i = 12; i >= 0; i--) {
        set.add(RANKS[i] + RANKS[i]);
        for (let j = i - 1; j >= 0; j--) { set.add(RANKS[i] + RANKS[j] + 's'); set.add(RANKS[i] + RANKS[j] + 'o'); }
      }
      return set;
    }
    String(str).split(/[,，\s]+/).forEach(tokRaw => {
      const tok = tokRaw.trim();
      if (!tok) return;
      const m = tok.match(/^([AKQJT98765432])([AKQJT98765432])([so])?(\+)?$/i);
      if (!m) return;
      const r1 = m[1].toUpperCase(), r2 = m[2].toUpperCase();
      const suit = m[3] ? m[3].toLowerCase() : null;
      const plus = !!m[4];
      const i1 = RANK_VAL[r1], i2 = RANK_VAL[r2];

      if (r1 === r2) {                     // 对子：99+ 表示 99 TT JJ QQ KK AA
        if (plus) for (let k = i1; k <= 12; k++) set.add(RANKS[k] + RANKS[k]);
        else set.add(r1 + r2);
        return;
      }
      // 非对子：统一写成「高张在前」
      const hi = i1 > i2 ? r1 : r2;
      const lo = i1 > i2 ? r2 : r1;
      const hiV = Math.max(i1, i2), loV = Math.min(i1, i2);
      const suits = suit ? [suit] : ['s', 'o'];   // 不写花色 -> both
      if (plus) {
        // A2s+ = A2s A3s ... AKs（低张从 loV 升到 hiV-1）
        for (let k = loV; k < hiV; k++) suits.forEach(su => set.add(hi + RANKS[k] + su));
      } else {
        suits.forEach(su => set.add(hi + lo + su));
      }
    });
    return set;
  }

  /** 单手握牌的组合数：对子6、同花4、非同花12 */
  function handCombos(h) {
    return h.length === 2 ? 6 : (h[2] === 's' ? 4 : 12);
  }

  /**
   * 展开成具体组合。dead 为 Uint8Array(52) 或 null。
   * 返回整数编码 code = c1 * 52 + c2
   */
  function toCombos(handSet, dead) {
    const out = [];
    const free = c => !(dead && dead[c]);
    handSet.forEach(h => {
      const r1 = RANK_VAL[h[0]], r2 = RANK_VAL[h[1]];
      if (h.length === 2) {
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
          const c1 = r1 * 4 + a, c2 = r1 * 4 + b;
          if (free(c1) && free(c2)) out.push(c1 * 52 + c2);
        }
      } else if (h[2] === 's') {
        for (let s = 0; s < 4; s++) {
          const c1 = r1 * 4 + s, c2 = r2 * 4 + s;
          if (free(c1) && free(c2)) out.push(c1 * 52 + c2);
        }
      } else {
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          if (a === b) continue;
          const c1 = r1 * 4 + a, c2 = r2 * 4 + b;
          if (free(c1) && free(c2)) out.push(c1 * 52 + c2);
        }
      }
    });
    return out;
  }

  /** 范围占总组合的百分比 */
  function rangePct(handSet) {
    let n = 0;
    handSet.forEach(h => { n += handCombos(h); });
    return n / 1326 * 100;
  }

  /* ================================================================
   * 2. 牌型评估
   *    编码：pack(cat, tiebreakers)，cat 0..8，每个 tiebreaker 占 4 bit
   * ================================================================ */

  /**
   * 顺子判定。mask 约定：
   *   bit0..12  = rank 0(2) .. 12(A)，A 只作高张
   *   bit13     = A 作低张（轮子）的许可位，由调用方在「有 A」时置位
   * 这样 A-2-3-4-5 与 A-3-4-5 能被正确区分。
   */
  function straightHigh(mask) {
    // 常规顺子：6 高 .. A 高（hi 是最高牌 rank）
    for (let hi = 12; hi >= 4; hi--) {
      const need = 0x1F << (hi - 4);
      if ((mask & need) === need) return hi;
    }
    // 轮子 A-2-3-4-5：需要 bit13(A-low) + bit0(2) + bit1(3) + bit2(4) + bit3(5)
    if ((mask & (1 << 13)) && (mask & 0x0F) === 0x0F) return 3;
    return -1;
  }

  /** 由 rank 计数生成带 A-low 许可位的 mask */
  function buildRankMask(rc) {
    let mask = 0;
    for (let r = 0; r < 13; r++) if (rc[r] > 0) mask |= 1 << r;
    if (rc[12] > 0) mask |= 1 << 13;
    return mask;
  }

  function pack(cat, tie) {
    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 16 + (tie[i] === undefined ? 0 : tie[i]);
    return v;
  }

  /**
   * 5/6/7 张牌 -> 整数分值，越大越强
   * 注意：长度必须 >= 5，且不能含重复牌
   */
  function eval7(cs) {
    const n = cs.length;
    if (n < 5 || n > 7) throw new Error('eval7 需要 5-7 张牌，收到 ' + n);
    const rc = new Int8Array(13), sc = new Int8Array(4);
    for (let i = 0; i < n; i++) { const c = cs[i]; rc[c >> 2]++; sc[c & 3]++; }

    let fs = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) fs = s;

    let fmask = 0;
    if (fs >= 0) for (let i = 0; i < n; i++) {
      const c = cs[i];
      if ((c & 3) === fs) fmask |= 1 << (c >> 2);
    }
    if (fs >= 0 && (fmask >> 12 & 1)) fmask |= 1 << 13;   // 同花里含 A，允许轮子同花顺

    let quad = -1; const trip = [], pair = [];
    for (let r = 12; r >= 0; r--) {
      const n = rc[r];
      if (n === 4) quad = r;
      else if (n === 3) trip.push(r);
      else if (n === 2) pair.push(r);
    }

    if (fs >= 0) {
      const sf = straightHigh(fmask);
      if (sf >= 0) return pack(8, [sf]);
    }
    if (quad >= 0) {
      let k = 0;
      for (let r = 12; r >= 0; r--) if (r !== quad && rc[r] > 0) { k = r; break; }
      return pack(7, [quad, k]);
    }
    if (trip.length >= 2) return pack(6, [trip[0], trip[1]]);
    if (trip.length === 1 && pair.length >= 1) return pack(6, [trip[0], pair[0]]);

    if (fs >= 0) {
      const t = [];
      for (let r = 12; r >= 0 && t.length < 5; r--) if (fmask >> r & 1) t.push(r);
      return pack(5, t);
    }

    const mask = buildRankMask(rc);
    const sh = straightHigh(mask);
    if (sh >= 0) return pack(4, [sh]);

    if (trip.length === 1) {
      const k = [];
      for (let r = 12; r >= 0 && k.length < 2; r--) if (r !== trip[0] && rc[r] > 0) k.push(r);
      return pack(3, [trip[0], k[0], k[1]]);
    }
    if (pair.length >= 2) {
      let k = 0;
      for (let r = 12; r >= 0; r--) if (r !== pair[0] && r !== pair[1] && rc[r] > 0) { k = r; break; }
      return pack(2, [pair[0], pair[1], k]);
    }
    if (pair.length === 1) {
      const k = [];
      for (let r = 12; r >= 0 && k.length < 3; r--) if (r !== pair[0] && rc[r] > 0) k.push(r);
      return pack(1, [pair[0], k[0], k[1], k[2]]);
    }
    const t = [];
    for (let r = 12; r >= 0 && t.length < 5; r--) if (rc[r] > 0) t.push(r);
    return pack(0, t);
  }

  const CAT_NAME = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

  function handCatName(v) {
    let cat = v, div = 16 * 16 * 16 * 16 * 16;
    cat = Math.floor(v / div);
    return CAT_NAME[cat] || '?';
  }

  /* ================================================================
   * 3. 蒙特卡洛权益
   * ================================================================ */

  function shufflePick(pool, n) {
    // 局部洗牌取前 n 张，避免整池 shuffle
    for (let i = 0; i < n; i++) {
      const j = i + ((Math.random() * (pool.length - i)) | 0);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    return pool;
  }

  /**
   * 范围 vs 范围
   * combosA/comboB: 整数编码数组
   * 返回 { winA, winB, tie, valid, equityA, equityB }
   */
  function simulate(combosA, combosB, board, iterations) {
    const N = iterations || 20000;
    const bLen = board.length;
    const need = 5 - bLen;
    let winA = 0, winB = 0, tie = 0, valid = 0;

    const used = new Uint8Array(52);
    const deck = [];

    for (let it = 0; it < N; it++) {
      used.fill(0);
      board.forEach(c => { used[c] = 1; });

      const a = combosA[(Math.random() * combosA.length) | 0];
      const b = combosB[(Math.random() * combosB.length) | 0];
      const a1 = (a / 52) | 0, a2 = a % 52, b1 = (b / 52) | 0, b2 = b % 52;

      // 关键：必须先标记 a，再检查 b。
      // 否则「英雄与对手共用同一张牌」的组合不会被过滤，
      // eval7 收到重复牌会把牌力算错（对子手牌受影响最大）。
      if (used[a1] || used[a2] || a1 === a2) continue;
      used[a1] = used[a2] = 1;
      if (used[b1] || used[b2] || b1 === b2) continue;
      used[b1] = used[b2] = 1;

      deck.length = 0;
      for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
      shufflePick(deck, need);

      const ha = new Array(7), hb = new Array(7);
      ha[0] = a1; ha[1] = a2; hb[0] = b1; hb[1] = b2;
      for (let i = 0; i < bLen; i++) { ha[2 + i] = board[i]; hb[2 + i] = board[i]; }
      for (let i = 0; i < need; i++) { ha[2 + bLen + i] = deck[i]; hb[2 + bLen + i] = deck[i]; }

      const va = eval7(ha), vb = eval7(hb);
      if (va > vb) winA++;
      else if (vb > va) winB++;
      else tie++;
      valid++;
    }

    return {
      winA, winB, tie, valid,
      equityA: valid ? (winA + tie / 2) / valid : 0,
      equityB: valid ? (winB + tie / 2) / valid : 0
    };
  }

  /**
   * 固定底牌 vs 对手范围（这是翻后决策真正需要的量）
   * heroCards: [c1,c2]
   * 返回 equity（含平局分摊）
   */
  function equityVsRange(heroCards, villainCombos, board, iterations) {
    const N = iterations || 8000;
    const bLen = board.length;
    const need = 5 - bLen;
    let score = 0, valid = 0;
    const used = new Uint8Array(52);
    const deck = [];
    const heroBase = heroCards.slice();

    for (let it = 0; it < N; it++) {
      used.fill(0);
      board.forEach(c => { used[c] = 1; });
      heroBase.forEach(c => { used[c] = 1; });

      const v = villainCombos[(Math.random() * villainCombos.length) | 0];
      const v1 = (v / 52) | 0, v2 = v % 52;
      if (used[v1] || used[v2] || v1 === v2) continue;
      used[v1] = used[v2] = 1;

      deck.length = 0;
      for (let c = 0; c < 52; c++) if (!used[c]) deck.push(c);
      shufflePick(deck, need);

      const hh = new Array(7), hv = new Array(7);
      hh[0] = heroBase[0]; hh[1] = heroBase[1];
      hv[0] = v1; hv[1] = v2;
      for (let i = 0; i < bLen; i++) { hh[2 + i] = board[i]; hv[2 + i] = board[i]; }
      for (let i = 0; i < need; i++) { hh[2 + bLen + i] = deck[i]; hv[2 + bLen + i] = deck[i]; }

      const a = eval7(hh), b = eval7(hv);
      if (a > b) score += 1;
      else if (a === b) score += 0.5;
      valid++;
    }
    return valid ? score / valid : 0;
  }

  /* ================================================================
   * 4. 底池数学
   * ================================================================ */

  /** 跟注需要的权益：toCall / (pot + toCall) */
  function potOdds(pot, toCall) {
    if (toCall <= 0) return 0;
    return toCall / (pot + toCall);
  }

  /** 对手用尺度 s（占池比例）下注时的 Alpha = s / (1 + s) */
  function alpha(betFraction) {
    return betFraction / (1 + betFraction);
  }

  /** MDF = 1 - Alpha = 1 / (1 + s) */
  function mdf(betFraction) {
    return 1 / (1 + betFraction);
  }

  /** 几何增长下注：n 条街把 SPR 打光，每街下注占池比例 */
  function geometricSize(spr, streets) {
    if (streets <= 0) return 0;
    return Math.pow(1 + 2 * spr, 1 / streets) - 1;
  }

  /* ================================================================
   * 5. 牌面纹理分类
   * ================================================================ */

  /**
   * 顺子潜力：牌面 rank 最多有几张能挤进同一个「5 连窗口」。
   * A 会同时尝试作高张与作低张两种身份（轮子）。
   * 3 张牌面返回 3 表示三张全在同窗口（如 7-6-5），返回 2 则表示断开。
   */
  function straightPotential(ranksArr) {
    const base = [...new Set(ranksArr)];
    const variants = [base];
    if (base.indexOf(12) >= 0) variants.push(base.map(r => (r === 12 ? -1 : r)));
    let best = 0;
    variants.forEach(arr => {
      const uniq = [...new Set(arr)];
      for (let lo = -1; lo <= 8; lo++) {
        let c = 0;
        for (let i = 0; i < uniq.length; i++) if (uniq[i] >= lo && uniq[i] <= lo + 4) c++;
        if (c > best) best = c;
      }
    });
    return best;
  }

  /**
   * 分析翻牌（或转河）牌面
   * 返回结构化特征 + 两个优势评分
   */
  function classifyBoard(boardCards) {
    const n = boardCards.length;
    const ranks = boardCards.map(c => c >> 2).sort((a, b) => b - a);
    const suits = boardCards.map(c => c & 3);

    // 花色
    const suitCount = [0, 0, 0, 0];
    suits.forEach(s => suitCount[s]++);
    const maxSuit = Math.max(...suitCount);
    const suitType = n >= 3
      ? (maxSuit === n ? 'monotone' : maxSuit === n - 1 ? 'twoTone' : 'rainbow')
      : 'rainbow';

    // 对子
    const rankCount = {};
    ranks.forEach(r => { rankCount[r] = (rankCount[r] || 0) + 1; });
    const pairs = Object.keys(rankCount).filter(r => rankCount[r] >= 2).map(Number);
    const isPaired = pairs.length > 0;
    const isTrips = Object.keys(rankCount).some(r => rankCount[r] >= 3);

    // 连接度
    const potential = straightPotential(ranks);
    let hasStraightPossible;
    if (n >= 5) {
      // 河牌：直接判是否已成顺
      let m = 0;
      ranks.forEach(r => { m |= 1 << r; });
      if (m >> 12 & 1) m |= 1 << 13;
      hasStraightPossible = straightHigh(m) >= 0;
    } else {
      // 翻牌/转牌：全部落在同一 5 连窗口才算「顺子可能」
      hasStraightPossible = potential >= n;
    }
    // 缺口：牌面 rank 排序后的最大间隔
    const gaps = [];
    for (let i = 0; i < ranks.length - 1; i++) gaps.push(ranks[i] - ranks[i + 1]);
    const maxGap = gaps.length ? Math.max(...gaps) : 0;
    const span = ranks[0] - ranks[ranks.length - 1];

    const high = ranks[0];
    const isAceHigh = high === 12;
    const isLow = high <= 8;               // 最高牌 <= 8：低牌面
    const isMid = high >= 9 && high <= 10; // T/J 高

    // ---- 两个优势的启发式评分 ----
    // 基准：翻前加注者（PFR）vs 跟注者
    let rangeAdv = 0;   // >0 表示 PFR 有范围优势
    let nutAdv = 0;     // >0 表示 PFR 有坚果优势

    // A 高面：PFR 的 Ax 权重远高于跟注者
    if (isAceHigh) { rangeAdv += 0.55; nutAdv += 0.35; }
    // K 高面
    else if (high === 11) { rangeAdv += 0.35; nutAdv += 0.18; }
    // Q/J 高面：略微偏向 PFR
    else if (high >= 9) { rangeAdv += 0.15; nutAdv += 0.02; }
    // 低牌面（<=8 高）：跟注者有更多连牌、小对子
    else { rangeAdv -= 0.35; nutAdv -= 0.45; }

    // 连接度：越连，坚果越偏向跟注者（他的小连牌中顺子）
    if (hasStraightPossible) { nutAdv -= 0.35; rangeAdv -= 0.12; }
    if (maxGap <= 2 && span <= 5) { nutAdv -= 0.2; }   // 紧凑连面

    // 对子面：PFR 有更多高对，但坚果共享
    if (isTrips) { rangeAdv += 0.25; nutAdv -= 0.1; }
    else if (isPaired) { rangeAdv += 0.15; nutAdv -= 0.05; }
    else { rangeAdv -= 0.05; }                          // 无对子面：set 的可能性对双方均匀

    // 单色面：坚果同花通常归 PFR（他同花 A 更多），但跟注者也有同花连牌
    if (suitType === 'monotone') { nutAdv -= 0.15; rangeAdv += 0.05; }
    else if (suitType === 'twoTone') { nutAdv -= 0.05; }

    rangeAdv = clamp(rangeAdv, -1, 1);
    nutAdv = clamp(nutAdv, -1, 1);

    // ---- 干湿分类 ----
    let wetScore = 0;
    if (hasStraightPossible) wetScore += 2;
    if (maxGap <= 2) wetScore += 1;
    if (suitType === 'twoTone') wetScore += 1;
    if (suitType === 'monotone') wetScore += 2;
    if (isPaired) wetScore -= 1;
    if (isAceHigh && !hasStraightPossible) wetScore -= 1;
    const texture = wetScore >= 3 ? 'wet' : wetScore <= 0 ? 'dry' : 'medium';

    return {
      high, highRank: RANKS[high], isAceHigh, isLow, isMid,
      isPaired, isTrips, hasStraightPossible, potential, maxGap, span,
      suitType, suitTypeCN: { monotone: '单色', twoTone: '双色', rainbow: '彩虹' }[suitType],
      texture, textureCN: { dry: '干燥', medium: '中性', wet: '湿润' }[texture],
      rangeAdv, nutAdv
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ================================================================
   * 6. 翻前范围表
   *    6-max / 100bb / 无 ante 基线
   * ================================================================ */

  const PREFLOP = {
    UTG: { open: '55+,A2s+,KTs+,QTs+,JTs,T9s,98s,ATo+,KTo+,QJo' },
    MP:  { open: '44+,A2s+,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,ATo+,KTo+,QTo+,JTo' },
    CO:  { open: '22+,A2s+,K7s+,Q8s+,J8s+,T7s+,96s+,85s+,75s+,65s,54s,A8o+,KTo+,QTo+,JTo' },
    BTN: { open: '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,95s+,85s+,74s+,64s+,54s,A2o+,K8o+,Q9o+,J9o+,T9o' },
    SB:  { open: '22+,A2s+,K5s+,Q7s+,J8s+,T7s+,96s+,85s+,75s+,64s+,54s,A5o+,K9o+,Q9o+,J9o+,T9o' },
    BB:  { open: '' }
  };

  /**
   * 大盲的「翻后范围」。
   *
   * BB 不存在开池（open 为空），但他在翻后当然有范围——那是防守范围。
   * 早期版本漏了这一步：estimateVillainRange 拿到空字符串，展开成空集，
   * 于是 villainCombos.length === 0，equity 恒等于 0，而决策照常返回。
   * 结果就是「对手是大盲」的每一手翻后，所有跟注/弃牌判断全错，
   * 且没有任何报错。这类静默失效比抛异常危险得多。
   */
  const BB_DEFEND = {
    // 面对 UTG / MP 的开池：范围紧，防守也窄
    vsEarly: '22+,A2s+,K9s+,Q9s+,J9s+,T8s+,97s+,87s,76s,65s,ATo+,KJo+,QJo',
    // 面对 CO / BTN / SB 的开池：价格便宜且对手范围宽，防守可以很宽
    vsLate:  '22+,A2s+,K2s+,Q4s+,J6s+,T6s+,95s+,85s+,74s+,64s+,54s,A2o+,K5o+,Q7o+,J8o+,T8o+,98o,87o'
  };

  // 3bet 范围（面对一个 open），按「我方位置 vs 对手位置」简化成两档
  const THREEBET = {
    // 位置有利或对手在 CO/BTN（对手范围宽，我们 3bet 更线性、更宽）
    wide: 'TT+,AQs+,AKo,A5s,A4s,KQs,KJs,QJs,JTs,T9s,98s,AQo',
    // 位置不利或对手在 EP（对手范围紧，我们 3bet 极化、更窄）
    tight: 'QQ+,AKs,AKo,A5s,A4s,KQs,AQo'
  };

  const FOURBET = {
    value: 'QQ+,AKs,AKo',
    bluff: 'A5s,A4s,A3s,KQs'
  };

  const POS_ORDER = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

  function posIndex(p) { return POS_ORDER.indexOf(String(p || '').toUpperCase()); }

  /** 位置是否在对手之后行动（有利位置） */
  function inPosition(hero, villain) {
    const h = posIndex(hero), v = posIndex(villain);
    if (h < 0 || v < 0) return false;
    // BB 永远最后行动
    if (h === 5) return true;
    if (v === 5) return false;
    return h > v;
  }

  /* ================================================================
   * 7. 手牌强度分档
   * ================================================================ */

  // 169 手牌对随机手的权益（千分比整数），由 120,000 次蒙特卡洛预生成。
  // 生成方式见 tools/gen-equity-table.js，精度约 ±0.2%。
  const EQ_TABLE_RAW = [
    '22=505,33=533,44=571,55=602,66=634,77=663,88=692,99=721',
    'AA=851,AKs=670,AKo=654,AQs=661,AQo=646,AJs=654,AJo=635,ATs=647',
    'ATo=627,A9s=626,A9o=608,A8s=618,A8o=599,A7s=610,A7o=591,A6s=600',
    'A6o=579,A5s=600,A5o=577,A4s=591,A4o=565,A3s=586,A3o=557,A2s=576',
    'A2o=546,KK=825,KQs=634,KQo=614,KJs=627,KJo=605,KTs=618,KTo=597',
    'K9s=599,K9o=577,K8s=582,K8o=561,K7s=570,K7o=554,K6s=565,K6o=542',
    'K5s=557,K5o=534,K4s=548,K4o=522,K3s=539,K3o=515,K2s=533,K2o=506',
    'QQ=801,QJs=602,QJo=580,QTs=595,QTo=572,Q9s=573,Q9o=555,Q8s=561',
    'Q8o=535,Q7s=542,Q7o=518,Q6s=534,Q6o=511,Q5s=529,Q5o=501,Q4s=518',
    'Q4o=490,Q3s=509,Q3o=482,Q2s=503,Q2o=473,JJ=774,JTs=578,JTo=554',
    'J9s=558,J9o=532,J8s=541,J8o=515,J7s=525,J7o=495,J6s=506,J6o=476',
    'J5s=498,J5o=470,J4s=489,J4o=462,J3s=484,J3o=454,J2s=474,J2o=443',
    'TT=750,T9s=543,T9o=518,T8s=522,T8o=497,T7s=506,T7o=478,T6s=490',
    'T6o=459,T5s=474,T5o=442,T4s=465,T4o=438,T3s=458,T3o=426,T2s=447',
    'T2o=416,98s=507,98o=480,97s=490,97o=464,96s=473,96o=446,95s=457',
    '95o=426,94s=438,94o=407,93s=434,93o=400,92s=426,92o=391,87s=480',
    '87o=450,86s=463,86o=430,85s=446,85o=413,84s=428,84o=394,83s=407',
    '83o=374,82s=406,82o=367,76s=453,76o=423,75s=436,75o=403,74s=418',
    '74o=387,73s=400,73o=368,72s=382,72o=345,65s=431,65o=399,64s=414',
    '64o=379,63s=395,63o=363,62s=379,62o=338,54s=415,54o=380,53s=395',
    '53o=362,52s=378,52o=345,43s=389,43o=350,42s=365,42o=333,32s=359',
    '32o=323'
  ].join(',');

  let _eqCache = null;

  /** 169 手牌对随机手的权益表（惰性解析，O(169) 一次） */
  function handEquityTable() {
    if (_eqCache) return _eqCache;
    const t = {};
    EQ_TABLE_RAW.split(',').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return;
      t[pair.slice(0, eq)] = Number(pair.slice(eq + 1)) / 1000;
    });
    _eqCache = t;
    return t;
  }

  /** 手牌结构特征 */
  function handShape(hand) {
    const isPair = hand.length === 2;
    const suited = hand.length === 3 && hand[2] === 's';
    const r1 = RANK_VAL[hand[0]], r2 = RANK_VAL[hand[1]];
    const gap = Math.abs(r1 - r2) - 1;
    const connected = !isPair && gap <= 1;
    const hasAce = r1 === 12 || r2 === 12;
    const hasKing = r1 === 11 || r2 === 11;
    return { isPair, suited, gap, connected, hasAce, hasKing, hi: Math.max(r1, r2), lo: Math.min(r1, r2) };
  }

  /** 用于范围排序的可玩性评分（0-1，越大越好） */
  function playability(hand, eqTable) {
    const eq = (eqTable || handEquityTable())[hand] || 0;
    const s = handShape(hand);
    let bonus = 0;
    if (s.suited) bonus += 0.035;
    if (s.connected) bonus += 0.025;
    if (s.isPair) bonus += 0.02 + (s.hi / 12) * 0.06;
    if (s.hasAce) bonus += 0.02;
    if (!s.isPair && s.gap >= 4 && !s.hasAce) bonus -= 0.02;  // 隔张垃圾（K7o、Q6o）
    return eq + bonus;
  }

  let _rankCache = null;

  /**
   * 169 手牌按可玩性降序排名（0 = 最强）。
   * 用它替代「可玩性绝对值 vs 硬编码门槛」的比较，
   * 保证边缘混合区间与范围表边界一致。
   */
  function playabilityRank() {
    if (_rankCache) return _rankCache;
    const tbl = handEquityTable();
    const arr = Object.keys(tbl).map(h => ({ h, s: playability(h, tbl) }));
    arr.sort((a, b) => b.s - a.s);
    const rank = {};
    arr.forEach((x, i) => { rank[x.h] = i; });
    _rankCache = rank;
    return rank;
  }

  /** 某个范围里「最弱那一手」的排名（越大越弱） */
  function worstRankOf(handSet, rank) {
    let worst = -1;
    handSet.forEach(h => { if (rank[h] > worst) worst = rank[h]; });
    return worst;
  }

  let _pctCache = null;

  /**
   * 每手牌的「累计组合数百分位」。
   * 范围表是按组合数定义的（AA 占 6 组合、AKo 占 12 组合），
   * 所以判断边界必须用组合数加权，用手数排名会失真。
   */
  function comboPercentile() {
    if (_pctCache) return _pctCache;
    const tbl = handEquityTable();
    const arr = Object.keys(tbl).map(h => ({ h, s: playability(h, tbl) }));
    arr.sort((a, b) => b.s - a.s);
    let cum = 0;
    const out = {};
    arr.forEach(x => { cum += handCombos(x.h); out[x.h] = cum / 1326; });
    _pctCache = out;
    return out;
  }

  /* ================================================================
   * 8. 翻前决策
   * ================================================================ */

  /**
   * @param {object} st 规范化后的 hand state
   * @returns {object} 决策
   */
  function advisePreflop(st) {
    const hero = st.hero.pos;
    const hand = st.hero.handClass;      // "AKs"
    const facing = st.toCall > 0;
    const raiseCount = st.raiseCount || 0;   // 之前已加注次数
    const villainPos = st.villainPos || null;

    const eqTable = handEquityTable();
    const eq = eqTable[hand] || 0;
    const play = playability(hand, eqTable);
    const reasons = [];

    // --- 情形 1：面对 3bet+（raiseCount >= 2）---
    if (raiseCount >= 2) {
      const fourBet = expandRange(FOURBET.value);
      const fourBetBluff = expandRange(FOURBET.bluff);
      const stackBB = st.effectiveStack || 100;

      // 短筹码优先走 push/fold：20bb 的 4bet 已经接近全下，
      // 不如直接全下，避免在翻后留下一个「底池比筹码还大」的残局
      if (stackBB <= 30) {
        const shoveThresh = 0.52 - (stackBB - 15) * 0.004;
        if (play >= shoveThresh) {
          reasons.push(`有效筹码仅 ${stackBB}bb，已进入 push/fold 区，不再有翻后操作空间。`);
          reasons.push(`${hand} 的可玩性 ${play.toFixed(3)} 超过 ${stackBB}bb 的全下门槛 ${shoveThresh.toFixed(3)}；短筹码要优先看「能不能全下」而不是「能不能跟注」。`);
          return dec('allin', null, 0.9, 'medium', reasons);
        }
        reasons.push(`有效筹码 ${stackBB}bb 属 push/fold 区，${hand} 未达全下门槛。`);
        reasons.push('短筹码下所有决策都应简化为「全下或弃牌」；任何跟注都会把 3bet 的劣势留给翻后，反而更亏。');
        return dec('fold', null, 0.85, 'medium', reasons);
      }

      if (fourBet.has(hand)) {
        reasons.push(`${hand} 属于 4bet 价值核心，对随机手权益 ${pct(eq)}，几乎无条件继续。`);
        reasons.push('4bet 的价值范围必须窄而硬：这些手牌在翻后即使被跟注也仍是顶端，不会陷入「中牌不敢打、弃牌又舍不得」的困境。');
        const fbAbs = st.toCall + (st.pot + st.toCall);
        reasons.push(`4bet 尺度约 2.2 倍对手的 3bet 总额（这里到 ${fbAbs.toFixed(1)}）；再大只会把对手的更弱牌全部赶走。`);
        return dec('4bet', { fraction: fbAbs / Math.max(st.pot, 0.01), absolute: fbAbs, unit: 'bb' }, 0.95, 'high', reasons, {
          note: '若对手 4bet 频率极低（<6%），可改为跟注控池，避免把强牌打成弃牌。'
        });
      }
      if (fourBetBluff.has(hand)) {
        reasons.push(`${hand} 是标准的 4bet 诈唬候选：带 A/K blocker，被跟注后仍有后门权益。`);
        reasons.push('这类牌的收益不来自成牌强度，而来自阻断 —— 你手里有 A，对手拿到 AA/AK 的组合数就少了一截。');
        const fbbAbs = st.toCall + (st.pot + st.toCall);
        return dec('4bet', { fraction: fbbAbs / Math.max(st.pot, 0.01), absolute: fbbAbs, unit: 'bb' }, 0.55, 'low', reasons, { mixed: true });
      }
      // 跟注范围：中等对子 + 适合同花 + 强非同花
      const callOk = (handShape(hand).isPair && RANK_VAL[hand[0]] >= 5) ||
                     (handShape(hand).suited && play > 0.55) ||
                     ['AQs', 'AQo', 'AJs', 'KQs', 'TT', '99'].includes(hand);
      if (callOk) {
        reasons.push(`面对 3bet，${hand} 有足够权益跟注（${pct(eq)}），但不足以 4bet。位置${inPosition(hero, villainPos) ? '有利' : '不利'}。`);
        reasons.push('跟注 3bet 要接受「范围被压制」：你的成牌强度上限低于对手，所以只能靠位置和隐含赔率兑现。');
        return dec('call', null, 0.6, 'medium', reasons);
      }
      reasons.push(`面对 3bet，${hand} 权益仅 ${pct(eq)}，不足以支撑继续。`);
      reasons.push('3bet 后的底池已经显著放大，用边缘牌跟注会把位置劣势成倍放大；弃牌保留 0 EV 是更好的选择。');
      return dec('fold', null, 0.9, 'high', reasons);
    }

    // --- 情形 2：面对单个 open（raiseCount == 1）---
    if (facing && raiseCount === 1) {
      const openPos = villainPos || 'MP';
      const villainLate = posIndex(openPos) >= posIndex('CO');
      const threeBetSet = expandRange(villainLate ? THREEBET.wide : THREEBET.tight);

      if (threeBetSet.has(hand)) {
        const inPos = inPosition(hero, openPos);
        reasons.push(`对手在 ${openPos} 开池，${villainLate ? '范围较宽' : '范围较紧'}；${hand} 在 3bet 范围内。`);
        reasons.push(inPos ? '位置有利，可用更线性的 3bet 范围。' : '位置不利，3bet 需更极化（强牌 + blocker 诈唬）。');
        return dec('3bet', { fraction: 9 / Math.max(st.pot, 0.01), absolute: 9, unit: 'bb' }, 0.85, 'high', reasons);
      }

      // 跟注：位置有利 + 有可玩性
      const inPos = inPosition(hero, openPos);
      if (inPos && play >= 0.48) {
        reasons.push(`${hand} 不在 3bet 范围，但位置有利（${hero} vs ${openPos}），可玩性 ${play.toFixed(3)} 支持跟注。`);
        reasons.push('位置有利的跟注能实现更多权益，这是跟注范围可以比 3bet 范围更宽的原因。');
        return dec('call', null, 0.6, 'medium', reasons);
      }
      if (hero === 'BB' && play >= 0.42) {
        reasons.push(`大盲已投入 ${(st.hero.invested || 1)}bb，实际只需补 ${st.toCall.toFixed(1)}bb，赔率要求极低。`);
        reasons.push('BB 的跟注范围可以非常宽，因为价格便宜；但翻后必须严格按牌面和尺度执行，不能因为「已经投了钱」而过度防守。');
        return dec('call', null, 0.8, 'medium', reasons);
      }
      if (hero === 'SB') {
        reasons.push('小盲位置不利且翻后要最先行动，默认 3bet or fold，不用跟注范围。');
        reasons.push('这条规则的根源不在手牌强度，而在行动顺序：小盲每条街都要先亮牌，权益实现率最低，跟注等于主动放弃这部分权益。');
        return dec('fold', null, 0.75, 'medium', reasons);
      }
      reasons.push(`${hand} 不在 3bet 范围，而且在 ${hero} vs ${openPos} 这个组合里位置不利。`);
      reasons.push('位置不利时跟注会同时失去「权益实现率」和「主动权」，所以这里宁可弃牌，也不要用边缘牌去争一个翻后必然被动的底池。');
      return dec('fold', null, 0.85, 'medium', reasons);
    }

    // --- 情形 3：无人入池，我是 RFI ---
    const openSet = expandRange(PREFLOP[hero] ? PREFLOP[hero].open : '');
    if (openSet.has(hand)) {
      const pctOpen = rangePct(openSet);
      reasons.push(`${hero} 的开池范围约 ${pctOpen.toFixed(1)}%，${hand} 在其中。`);
      const openBB = hero === 'SB' ? 3 : 2.3;
      reasons.push(`开池尺度 ${openBB}bb（约 ${(openBB / Math.max(st.pot, 1)).toFixed(2)}× 当前底池）：小尺度降低风险、留出 4bet 空间，也让对手用更宽的范围防守。`);
      return dec('raise', { fraction: openBB / Math.max(st.pot, 1), absolute: openBB, unit: 'bb' }, 0.95, 'high', reasons);
    }

    // 边缘：用「组合数百分位」判断是否紧贴开池范围边界
    const pctMap = comboPercentile();
    const myPct = pctMap[hand] === undefined ? 1 : pctMap[hand];
    const openPct = rangePct(openSet) / 100;
    // 只给 1.2 个百分点的余量：范围表是基准，引擎不该明显偏离它
    const isEdge = myPct <= openPct + 0.012 && hero !== 'BB';

    if (isEdge) {
      reasons.push(`${hand} 按组合数处在约 ${pct(myPct)} 的位置，紧贴 ${hero} 的开池边界（${pct(openPct)}）。`);
      reasons.push('这类手牌在 solver 里通常是混合策略，接近 50% 的频率都属正常；位置越靠后，边界越会向右移动。');
      return dec('raise', { fraction: 2.3 / Math.max(st.pot, 1), absolute: 2.3, unit: 'bb' }, 0.5, 'low', reasons, { mixed: true });
    }

    reasons.push(`${hand} 按组合数处在约 ${pct(myPct)} 的位置，明显超出 ${hero} 的开池边界（${pct(openPct)}）。`);
    reasons.push('弃牌的 EV 是 0；边缘手牌强行入池，在位置不利时会持续放大负 EV。');
    return dec('fold', null, 0.9, 'high', reasons);
  }

  /* ================================================================
   * 9. 翻后决策
   * ================================================================ */

  /** 从动作历史推断对手范围（简化模型） */
  function estimateVillainRange(st) {
    if (st.villainRange) {
      const set = expandRange(st.villainRange);
      if (set.size) return set;
    }
    const openPos = st.villainOpenPos || st.villainPos || 'MP';
    let base = PREFLOP[openPos] ? PREFLOP[openPos].open : PREFLOP.MP.open;

    // 大盲没有开池范围，但翻后确实有范围 —— 用防守范围补上。
    // 缺了这一步，equity 会恒为 0 而决策照常返回，属于最难发现的错误。
    if (!base) {
      const openerPos = (st.hero && st.hero.pos) || 'MP';
      base = posIndex(openerPos) >= posIndex('CO') ? BB_DEFEND.vsLate : BB_DEFEND.vsEarly;
    }

    let set = expandRange(base);
    if (!set.size) set = expandRange(BB_DEFEND.vsLate);
    // 若对手在翻后加注过，收窄到强价值 + 部分诈唬
    if (st.villainRaisedPostflop) {
      const tight = new Set();
      set.forEach(h => {
        const s = handShape(h);
        if (s.isPair && s.hi >= 9) tight.add(h);
        else if (s.hi === 12 && s.lo >= 9) tight.add(h);
        else if (s.suited && s.hi >= 10) tight.add(h);
        else if (s.connected && s.suited) tight.add(h);
      });
      if (tight.size) set = tight;
    }

    // 对手主动下注 → 他的实际范围比「开池范围」窄。
    // 尺度越大，范围越偏向价值，收窄越明显。
    if (st.toCall > 0) {
      const potBefore = Math.max(st.pot - st.toCall, 0.01);
      const frac = st.toCall / potBefore;
      const keepRatio = frac <= 0.4 ? 0.78 : frac <= 0.7 ? 0.56 : 0.36;
      const tbl = handEquityTable();
      const arr = [];
      set.forEach(h => arr.push(h));
      arr.sort((a, b) => playability(b, tbl) - playability(a, tbl));
      const keep = Math.max(6, Math.round(arr.length * keepRatio));
      set = new Set(arr.slice(0, keep));
    }
    return set;
  }

  function advisePostflop(st) {
    const board = st.boardCards;
    const heroCards = st.heroCards;
    const pot = st.pot;
    const toCall = st.toCall;
    const facing = toCall > 0;
    const tex = classifyBoard(board);
    const reasons = [];

    // --- 对手范围与我的权益 ---
    const villainSet = estimateVillainRange(st);
    const dead = new Uint8Array(52);
    board.forEach(c => { dead[c] = 1; });
    heroCards.forEach(c => { dead[c] = 1; });
    const villainCombos = toCombos(villainSet, dead);
    const equity = villainCombos.length
      ? equityVsRange(heroCards, villainCombos, board, st.iterations || 6000)
      : 0;

    const itersLabel = `${(st.iterations || 6000) / 1000}k`;

    // --- 手牌成牌强度 ---
    const myHand = heroCards.concat(board);
    const myVal = myHand.length >= 5 ? eval7(myHand) : -1;
    const myCat = myHand.length >= 5 ? Math.floor(myVal / 1048576) : -1;

    // 相对强度：用「高牌/对子/两对以上」分层
    let madeStrength = 'air';
    const boardHighRank = tex.high;
    const heroRanks = heroCards.map(c => c >> 2);
    const boardRankSet = new Set(board.map(c => c >> 2));

    if (myCat >= 4) madeStrength = 'monster';         // 顺子及以上
    else if (myCat === 3) madeStrength = 'monster';   // 三条/set
    else if (myCat === 2) madeStrength = 'strong';    // 两对
    else if (myCat === 1) {
      // 一对：区分顶对 / 中对 / 底对 / 口袋对子
      let pr = -1;
      const cnt = {};
      myHand.forEach(c => { const r = c >> 2; cnt[r] = (cnt[r] || 0) + 1; });
      Object.keys(cnt).forEach(r => { if (cnt[r] >= 2) pr = Math.max(pr, Number(r)); });
      if (pr === boardHighRank) madeStrength = 'topPair';
      else if (pr > boardHighRank) madeStrength = 'overPair';
      else madeStrength = 'weakPair';
      st._pairRank = pr;
    } else madeStrength = 'air';

    // 听牌判定（简化：4 张同花 / 4 张顺）
    let draw = null;
    const suitOnBoard = [0, 0, 0, 0];
    myHand.forEach(c => suitOnBoard[c & 3]++);
    const mySuit = suitOnBoard[heroCards[0] & 3];
    if (mySuit === 4) draw = 'flushDraw';
    else {
      let mask = 0;
      const seen = new Set();
      myHand.forEach(c => { const r = c >> 2; if (!seen.has(r)) { seen.add(r); mask |= 1 << r; } });
      if (seen.has(12)) mask |= 1 << 13;   // 允许轮子听牌
      // 有 4 连张即算顺子听牌（简化为两头/卡顺合并）
      if (straightHigh(mask) < 0) {
        for (let r = 0; r < 13; r++) {
          if (mask >> r & 1) continue;
          if (straightHigh(mask | (1 << r)) >= 0) { draw = 'straightDraw'; break; }
        }
      }
    }

    if (!villainCombos.length) {
      reasons.push('⚠ 对手范围估值为空，权益按 0 处理，本建议不可用。请显式传 villainRange。');
    }

    reasons.push(`牌面 ${tex.highRank} 高 · ${tex.textureCN}（${tex.suitTypeCN}${tex.isPaired ? ' · 对子面' : ''}${tex.hasStraightPossible ? ' · 有顺子可能' : ''}）。`);
    reasons.push(`你的范围优势评分 ${tex.rangeAdv.toFixed(2)}，坚果优势评分 ${tex.nutAdv.toFixed(2)}（正数偏向翻前加注者）。`);
    reasons.push(`你当前成牌：${madeStrength === 'air' ? '无对子（空气）' : madeStrength === 'monster' ? '强成牌（三条以上）' : madeStrength === 'strong' ? '两对' : madeStrength === 'topPair' ? '顶对' : madeStrength === 'overPair' ? '超对' : '弱对子'}${draw ? ` + ${draw === 'flushDraw' ? '同花听牌' : '顺子听牌'}` : ''}。`);
    reasons.push(`对估计的对手范围，你的权益 ${pct(equity)}（${itersLabel} 次蒙特卡洛）。`);

    // ================= 分支 A：面对下注 =================
    if (facing) {
      const betFraction = st.betFraction != null ? st.betFraction : (toCall / Math.max(pot - toCall, 0.01));
      const needEq = potOdds(pot, toCall);
      const mdfVal = mdf(betFraction);
      const alphaVal = alpha(betFraction);

      reasons.push(`跟注 ${toCall.toFixed(1)} 抢 ${pot.toFixed(1)}：需要权益 ${pct(needEq)}，你实际有 ${pct(equity)}。`);
      reasons.push(`对手这个尺度下，你的最低防守频率（MDF）是 ${pct(mdfVal)}，对手的自动盈利门槛（Alpha）是 ${pct(alphaVal)}。`);

      const edge = equity - needEq;

      // 强牌 -> 加注
      if (equity > needEq + 0.28 && (madeStrength === 'monster' || madeStrength === 'strong' || (madeStrength === 'topPair' && tex.nutAdv > -0.1))) {
        reasons.push(`权益显著高于所需（+${pct(edge)}），且成牌强度足够，加注比跟注更能兑现价值。`);
        reasons.push('加注同时保护你的跟注范围：如果这里只用坚果加注，跟注范围就成了纯弱牌，容易被对手过度下注剥削。');
        const raiseAbs = toCall + (pot + toCall) * 0.8;
        return dec('raise', { fraction: raiseAbs / pot, absolute: raiseAbs, unit: 'pot' }, 0.8, 'high', reasons, { equity, potOdds: needEq, mdf: mdfVal });
      }

      // 听牌 -> 按赔率 + 隐含赔率决定
      if (draw && madeStrength !== 'monster') {
        const impliedNeed = needEq * 0.75;   // 听牌可用隐含赔率打折要求
        if (equity >= impliedNeed) {
          reasons.push(`${draw === 'flushDraw' ? '同花听牌' : '顺子听牌'}有隐含赔率：命中后还能赢到后续下注，所以实际门槛从 ${pct(needEq)} 降到约 ${pct(impliedNeed)}。`);
          return dec('call', null, 0.7, 'medium', reasons, { equity, potOdds: needEq, mdf: mdfVal });
        }
      }

      // 弱对子面对大尺度：权益实现率低 + 对手范围偏价值，要求更大余量
      const isWeakMade = (madeStrength === 'weakPair');
      const extraMargin = (isWeakMade && betFraction > 0.6) ? 0.08 : 0.02;

      // 边缘：跟注
      if (equity > needEq + extraMargin) {
        reasons.push(`权益刚好覆盖赔率要求（余量 ${pct(edge)}），跟注成立。`);
        if (madeStrength === 'weakPair') reasons.push('注意：弱对子跟注主要靠抓诈唬，对手若是低诈唬频率的玩家，这里应直接弃牌。');
        return dec('call', null, 0.65, 'medium', reasons, { equity, potOdds: needEq, mdf: mdfVal });
      }

      // 弃牌
      if (isWeakMade && betFraction > 0.6) {
        reasons.push(`你的权益 ${pct(equity)} 虽然略高于赔率要求 ${pct(needEq)}，但弱对子面对大尺度下注时权益实现率很低。`);
        reasons.push('弱对子的问题不是「现在够不够」，而是「后面两条街还会被继续压」：对手范围偏价值，你被动跟注只能不断付钱。');
      } else {
        reasons.push(`权益 ${pct(equity)} 低于所需 ${pct(needEq)}，跟注是负 EV。`);
        reasons.push('弃牌不是损失，是把筹码留给权益真正够的场景。');
      }
      if (draw) reasons.push('听牌的赔率不够，且没有足够的隐含赔率补偿。');
      return dec('fold', null, 0.85, 'high', reasons, { equity, potOdds: needEq, mdf: mdfVal });
    }

    // ================= 分支 B：轮到我主动（过牌 or 下注）=================
    const spr = st.pot > 0 ? (st.hero.stack - st.hero.invested) / st.pot : 5;
    reasons.push(`有效 SPR ≈ ${spr.toFixed(1)}。`);

    // 下注频率：由范围优势驱动
    let betFreq = 0.5 + tex.rangeAdv * 0.45;
    // 转牌/河牌：极化程度提高，频率整体下降但价值更集中
    const streetAdj = st.street === 'river' ? -0.15 : st.street === 'turn' ? -0.05 : 0;
    betFreq = clamp(betFreq + streetAdj, 0.08, 0.95);

    // 尺度：坚果优势决定
    let sizeFrac;
    if (tex.nutAdv > 0.15) { sizeFrac = 0.66; reasons.push('坚果优势在你这边，可用较大的尺度（2/3 池）。'); }
    else if (tex.nutAdv < -0.2) { sizeFrac = 0.33; reasons.push('坚果优势在对手那边（他能有更多两对以上），尺度要小，避免被加注。'); }
    else { sizeFrac = 0.5; }

    if (betFreq > 0.7) {
      sizeFrac = Math.min(sizeFrac, 0.33);
      reasons.push(`范围优势明显，下注频率高（约 ${pct(betFreq)}）—— 高频率必须配小尺度，否则弱牌跟不上，整个范围反而会被加注剥削。`);
    } else if (betFreq < 0.3) {
      // 低频不改变尺度：低频时下注范围本就极化，尺度仍由坚果优势决定
      reasons.push(`范围优势弱，下注频率低（约 ${pct(betFreq)}）—— 下注范围收窄到两极化：强成牌要价值，少量 blocker 牌做诈唬，中间强度全部过牌。`);
    }

    // 具体这手牌：价值 / 诈唬 / 摊牌
    if (equity > 0.68 || madeStrength === 'monster' || madeStrength === 'strong') {
      reasons.push(`你这手牌属于价值下注区间（权益 ${pct(equity)}），应该下注而不是过牌。`);
      if (st.street === 'river') reasons.push('河牌的价值下注由「能跟注的更差牌」定义 —— 确认对手范围里有足够多的更差牌。');
      return dec('bet', { fraction: sizeFrac, absolute: pot * sizeFrac, unit: 'pot' }, 0.85, 'high', reasons, { equity, betFreq, spr });
    }

    if (madeStrength === 'topPair' || madeStrength === 'overPair') {
      // 顶对：取决于牌面和 street
      if (tex.nutAdv < -0.25) {
        reasons.push('顶对在坚果劣势牌面应该控池：过牌保留对手的诈唬，比下注被加注更安全。');
        return dec('check', null, 0.65, 'medium', reasons, { equity, betFreq, spr });
      }
      reasons.push('顶对属于可以打两条街但不适合打三条街的牌，这里下注是标准线。');
      return dec('bet', { fraction: Math.min(sizeFrac, 0.5), absolute: pot * Math.min(sizeFrac, 0.5), unit: 'pot' }, 0.7, 'medium', reasons, { equity, betFreq, spr });
    }

    if (equity < 0.32 && draw) {
      reasons.push(`成牌弱但有 ${draw === 'flushDraw' ? '同花' : '顺子'}听牌，属于半诈唬候选。`);
      reasons.push('半诈唬的价值来自两处：对手弃牌的即时收益 + 听牌命中的后续收益。');
      return dec('bet', { fraction: sizeFrac, absolute: pot * sizeFrac, unit: 'pot' }, 0.55, 'low', reasons, { equity, betFreq, spr, mixed: true });
    }

    if (equity < 0.32 && !draw) {
      // 纯空气：只在牌面极有利时诈唬
      if (tex.rangeAdv > 0.35 && tex.nutAdv > 0) {
        reasons.push('虽然没成牌，但牌面结构对你（加注者）有利，可用小尺度高频诈唬，配合你的整体范围频率。');
        return dec('bet', { fraction: 0.25, absolute: pot * 0.25, unit: 'pot' }, 0.4, 'low', reasons, { equity, betFreq, spr, mixed: true });
      }
      reasons.push('既没成牌也没听牌，牌面也不支持诈唬，过牌。');
      return dec('check', null, 0.85, 'high', reasons, { equity, betFreq, spr });
    }

    reasons.push(`中等强度的牌（权益 ${pct(equity)}）适合过牌控池，保留对手的诈唬范围。`);
    return dec('check', null, 0.7, 'medium', reasons, { equity, betFreq, spr });
  }

  /* ================================================================
   * 10. 对外接口
   * ================================================================ */

  function dec(action, sizing, freq, confidence, reasons, extra) {
    const out = {
      action,
      actionCN: { fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注', '3bet': '3bet', '4bet': '4bet', allin: '全下' }[action] || action,
      sizing: sizing
        ? { fraction: sizing.fraction, absolute: sizing.absolute, unit: sizing.unit || 'pot' }
        : null,
      frequency: freq,
      confidence,
      reasons,
      note: (extra && extra.note) || null,
      metrics: {}
    };
    if (extra) {
      ['equity', 'potOdds', 'mdf', 'betFreq', 'spr', 'mixed'].forEach(k => {
        if (extra[k] !== undefined) out.metrics[k] = extra[k];
      });
      out.mixed = !!extra.mixed;
    }
    return out;
  }

  function pct(v) { return (v * 100).toFixed(1) + '%'; }

  /** 169 手牌分类名："AsKh" -> "AKo" */
  function handClass(cardA, cardB) {
    const r1 = cardA >> 2, r2 = cardB >> 2;
    if (r1 === r2) return RANKS[r1] + RANKS[r2];
    const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
    const suited = (cardA & 3) === (cardB & 3);
    return RANKS[hi] + RANKS[lo] + (suited ? 's' : 'o');
  }

  /**
   * 规范化输入：容忍各种松散写法
   */
  function normalize(input) {
    const st = Object.assign({}, input);
    const board = parseCards(input.board || input.boardCards || []);
    st.boardCards = board.slice(0, 5);

    // 手牌
    let heroCards = parseCards(input.hero && (input.hero.cards || input.heroCards) || []);
    if (heroCards.length !== 2) throw new Error('hero.cards 必须是两张合法牌，例如 ["As","Kh"]');
    st.heroCards = heroCards;

    const street = String(input.street || (board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : board.length === 3 ? 'flop' : 'preflop')).toLowerCase();
    st.street = street;

    const heroPos = String((input.hero && input.hero.pos) || input.pos || 'BTN').toUpperCase();
    st.hero = Object.assign({}, input.hero, {
      pos: heroPos,
      cards: heroCards,
      stack: num(input.hero && input.hero.stack, 100),
      invested: num(input.hero && input.hero.invested, 0),
      handClass: handClass(heroCards[0], heroCards[1])
    });

    st.pot = num(input.pot, 0);
    st.toCall = num(input.toCall, 0);
    st.effectiveStack = num(input.effectiveStack, st.hero.stack);
    st.villainPos = input.villainPos ? String(input.villainPos).toUpperCase() : null;
    st.villainOpenPos = input.villainOpenPos ? String(input.villainOpenPos).toUpperCase() : null;
    st.raiseCount = num(input.raiseCount, st.toCall > 0 ? 1 : 0);
    st.numPlayers = num(input.numPlayers, 2);
    st.villainRange = input.villainRange || null;
    st.villainRaisedPostflop = !!input.villainRaisedPostflop;
    st.iterations = num(input.iterations, 6000);

    // betFraction 推导
    if (st.betFraction == null && st.toCall > 0) {
      const potBefore = st.pot - st.toCall;
      st.betFraction = potBefore > 0 ? st.toCall / potBefore : 0.5;
    }
    return st;
  }

  function num(v, dflt) {
    const n = Number(v);
    return isFinite(n) ? n : dflt;
  }

  /**
   * 主入口
   * @param {object} input hand state
   * @returns {object} 决策
   */
  function advise(input) {
    const st = normalize(input);
    let result;
    if (st.street === 'preflop') result = advisePreflop(st);
    else result = advisePostflop(st);

    result.street = st.street;
    result.handClass = st.hero.handClass;
    result.position = st.hero.pos;

    if (st.street !== 'preflop') {
      const tex = classifyBoard(st.boardCards);
      result.board = {
        texture: tex.texture, textureCN: tex.textureCN,
        suitType: tex.suitType, suitTypeCN: tex.suitTypeCN,
        rangeAdv: tex.rangeAdv, nutAdv: tex.nutAdv,
        hasStraightPossible: tex.hasStraightPossible,
        isPaired: tex.isPaired
      };
    }
    return result;
  }

  /**
   * 批量复盘：输入一串 hand state，逐条给出建议
   */
  function replay(states, opts) {
    return states.map((s, i) => {
      try {
        return Object.assign({ index: i, ok: true }, { decision: advise(Object.assign({}, opts, s)) });
      } catch (e) {
        return { index: i, ok: false, error: e.message };
      }
    });
  }

  /* ---------------------------------------------------------------- */
  return {
    // 牌
    parseCard, cardStr, cardPretty, parseCards, handClass,
    // 范围
    expandRange, handCombos, toCombos, rangePct,
    // 牌型
    eval7, straightHigh, handCatName, CAT_NAME,
    // 模拟
    simulate, equityVsRange,
    // 数学
    potOdds, alpha, mdf, geometricSize,
    // 牌面
    classifyBoard,
    // 策略
    advise, advisePreflop, advisePostflop, replay,
    // 数据
    PREFLOP, THREEBET, FOURBET,
    // 辅助
    normalize, playability, handShape, handEquityTable, inPosition,
    version: '1.0.0'
  };
});
