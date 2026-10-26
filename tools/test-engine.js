#!/usr/bin/env node
/**
 * test-engine.js — gto-engine 自测
 *
 *   node tools/test-engine.js          完整（约 90 秒）
 *   node tools/test-engine.js --fast   抽样（约 15 秒）
 *
 * 五组测试：
 *   1. 基础：牌解析、范围展开、组合数学
 *   2. 牌型评估：与独立暴力枚举差分比对
 *   3. 权益：与完整枚举（1,712,304 局）比对
 *   4. 牌面分类：纹理、顺子潜力、优势归属
 *   5. 全量扫描：翻前 6 位置 × 169 手 × 6 场景，翻后各街
 */

'use strict';

const G = require('../engine/gto-engine.js');

const FAST = process.argv.indexOf('--fast') >= 0;
const DIFF_ROUNDS = FAST ? 20000 : 100000;
const FULL_SCAN = !FAST;

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2714 ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; failures.push(name + (extra !== undefined ? '  ' + extra : '')); console.log('  \u2718 ' + name + '  ' + (extra === undefined ? '' : extra)); }
}

function section(t) { console.log('\n' + t); }

/* ---------------------------------------------------------------- */
/* 辅助：把手牌类如 "A2o" 展开成两张具体牌                            */
/* ---------------------------------------------------------------- */
function cardsOf(h) {
  if (h.length === 2) return [h[0] + 's', h[0] + 'h'];
  return [h[0] + 's', h[1] + (h[2] === 's' ? 's' : 'h')];
}

/* ================================================================
 * 1. 基础
 * ================================================================ */
function testBasics() {
  section('1. 牌与范围');

  ok('parseCard("As") === 48', G.parseCard('As') === 48, G.parseCard('As'));
  ok('cardStr(48) === "As"', G.cardStr(48) === 'As');
  ok('解析带空格', G.parseCards('As Kh 7d').length === 3);
  ok('解析无分隔', G.parseCards('AsKh7d').length === 3);
  ok('解析数组', G.parseCards(['As', 'Kh']).join() === '48,45');
  ok('丢弃非法牌', G.parseCards('As Xx Kh').length === 2);

  ok('handClass AKs', G.handClass(48, 44) === 'AKs', G.handClass(48, 44));
  ok('handClass AQs', G.handClass(48, 40) === 'AQs', G.handClass(48, 40));
  ok('handClass AA', G.handClass(48, 49) === 'AA', G.handClass(48, 49));

  const comboCases = [
    ['AA', 6], ['AKs', 4], ['AKo', 12], ['AK', 16],
    ['22+', 78], ['99+', 36], ['A2s+', 48], ['ATo+', 48],
    ['QJo', 12], ['T9s', 4], ['all', 1326]
  ];
  comboCases.forEach(([h, want]) => {
    const got = G.toCombos(G.expandRange(h), null).length;
    ok(h + ' = ' + got + ' 组合', got === want, 'want ' + want);
  });

  ok('AA 占 0.45%', Math.abs(G.rangePct(G.expandRange('AA')) - 0.452) < 0.01);
  ok('全范围 100%', Math.abs(G.rangePct(G.expandRange('all')) - 100) < 0.01);
}

/* ================================================================
 * 2. 牌型评估差分
 * ================================================================ */
function ref5(cs) {
  const ranks = cs.map(c => c >> 2), suits = cs.map(c => c & 3);
  const flush = suits.every(s => s === suits[0]);
  const cnt = new Map();
  ranks.forEach(r => cnt.set(r, (cnt.get(r) || 0) + 1));
  const groups = [...cnt.entries()].map(([r, n]) => ({ r, n })).sort((a, b) => b.n - a.n || b.r - a.r);
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let sh = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) sh = uniq[0];
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0) sh = 3;
  }
  if (flush && sh >= 0) return { c: 8, t: [sh] };
  if (groups[0].n === 4) return { c: 7, t: [groups[0].r, groups[1].r] };
  if (groups[0].n === 3 && groups[1].n === 2) return { c: 6, t: [groups[0].r, groups[1].r] };
  if (flush) return { c: 5, t: uniq };
  if (sh >= 0) return { c: 4, t: [sh] };
  if (groups[0].n === 3) return { c: 3, t: [groups[0].r, groups[1].r, groups[2].r] };
  if (groups[0].n === 2 && groups[1].n === 2) return { c: 2, t: [groups[0].r, groups[1].r, groups[2].r] };
  if (groups[0].n === 2) return { c: 1, t: [groups[0].r, groups[1].r, groups[2].r, groups[3].r] };
  return { c: 0, t: uniq };
}
function cmpHand(a, b) {
  if (a.c !== b.c) return a.c - b.c;
  for (let i = 0; i < 5; i++) {
    const x = a.t[i] || 0, y = b.t[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
function refN(cs) {
  const n = cs.length;
  let best = null;
  (function rec(start, cur) {
    if (cur.length === 5) {
      const r = ref5(cur.map(i => cs[i]));
      if (!best || cmpHand(r, best) > 0) best = r;
      return;
    }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return best;
}
function decodeVal(v) {
  const d = [];
  let s = v;
  for (let i = 0; i < 5; i++) { d.unshift(s % 16); s = Math.floor(s / 16); }
  return { c: s, t: d };
}

function testEvaluator() {
  section('2. 牌型评估');

  const cases = [
    ['As Ks Qs Js Ts 2h 3d', 8, '皇家同花顺'],
    ['5s 4s 3s 2s As Kh Qd', 8, '钢轮同花顺'],
    ['Ah Ad Ac As Kh Qd Jc', 7, '四条'],
    ['Kh Kd Kc 2s 2h 3d 4c', 6, '葫芦'],
    ['As Ks 9s 7s 3s 2h 4d', 5, '同花'],
    ['9h 8d 7c 6s 5h As Kd', 4, '顺子'],
    ['Ah 2d 3c 4s 5h Kd Qc', 4, '轮子顺'],
    ['Qh Qd Qc 7s 2h 3d 4c', 3, '三条'],
    ['Jh Jd 8c 8s 2h 3d 4c', 2, '两对'],
    ['Th Td 9c 8s 2h 3d 4c', 1, '一对'],
    ['Ah Kd 9c 8s 5h 3d 2c', 0, '高牌'],
    ['7h 7d 6c 8s 4h 5d 2c', 4, '对子+顺子 判顺子'],
    ['Kh Ad 3s 5s 4h 8d 9d', 0, 'A3456（无 2）不是顺子'],
  ];
  cases.forEach(([cards, want, name]) => {
    const got = Math.floor(G.eval7(G.parseCards(cards)) / 1048576);
    ok(name, got === want, 'cat=' + got + ' want=' + want);
  });

  const wheel = G.eval7(G.parseCards('Ah 2d 3c 4s 5h Kd Qc'));
  const sixHigh = G.eval7(G.parseCards('2h 3d 4c 5s 6h Kd Qc'));
  ok('轮子顺 < 6 高顺', wheel < sixHigh);

  ok('5 张可评估', Math.floor(G.eval7(G.parseCards('As Ks 9s 7s 3s')) / 1048576) === 5);
  ok('4 张拒绝', (() => { try { G.eval7(G.parseCards('As Kh 7d 2c')); return false; } catch (e) { return true; } })());

  // 差分
  const RCH = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let totalBad = 0;
  [5, 6, 7].forEach(len => {
    let bad = 0;
    for (let it = 0; it < DIFF_ROUNDS; it++) {
      const pool = [...Array(52).keys()];
      for (let i = 0; i < len; i++) {
        const j = i + Math.floor(Math.random() * (52 - i));
        const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
      }
      const hand = pool.slice(0, len);
      const mine = decodeVal(G.eval7(hand));
      const ref = refN(hand);
      if (cmpHand(mine, ref) !== 0) {
        bad++; totalBad++;
        if (bad <= 3) {
          console.log('    分歧: ' + hand.map(c => RCH[c >> 2] + 'shdc'[c & 3]).join(' ') +
            ' mine=' + mine.c + JSON.stringify(mine.t) + ' ref=' + ref.c + JSON.stringify(ref.t));
        }
      }
    }
    ok(len + ' 张 × ' + DIFF_ROUNDS.toLocaleString() + ' 局零分歧', bad === 0, bad ? '分歧 ' + bad : '');
  });
  return totalBad === 0;
}

/* ================================================================
 * 3. 权益
 * ================================================================ */
function testEquity() {
  section('3. 权益（对照完整枚举真值）');

  // 完整枚举单一配对的全部 C(48,5)。
  // 同时用「引擎评估器」和「独立暴力评估器」各算一遍，互相比对 ——
  // 不硬编码期望数字，避免把 bug 当成真值写进测试。
  function exhaustive(aStr, bStr) {
    const a = G.parseCards(aStr), b = G.parseCards(bStr);
    const dead = new Uint8Array(52);
    a.forEach(c => dead[c] = 1); b.forEach(c => dead[c] = 1);
    const rest = [];
    for (let c = 0; c < 52; c++) if (!dead[c]) rest.push(c);
    let winA = 0, winB = 0, tie = 0, n = 0, mismatch = 0;
    const board = new Array(5);

    // 单局评估：顺带做交叉验证（只抽前 3000 局，全量比对太慢）
    function playOne() {
      const ha = [a[0], a[1], board[0], board[1], board[2], board[3], board[4]];
      const hb = [b[0], b[1], board[0], board[1], board[2], board[3], board[4]];
      const va = G.eval7(ha), vb = G.eval7(hb);
      if (n < 3000) {
        const ra = refN(ha), rb = refN(hb);
        if (cmpHand(decodeVal(va), ra) !== 0 || cmpHand(decodeVal(vb), rb) !== 0) mismatch++;
      }
      if (va > vb) winA++; else if (vb > va) winB++; else tie++;
      n++;
    }

    if (FAST) {
      // 快速模式：均匀随机抽样（固定步长会引入系统性偏差，不能用）
      const idx = [];
      for (let i = 0; i < 48; i++) idx.push(i);   // 必须是 48 个索引，不是 5 个
      for (let s = 0; s < 150000; s++) {
        // Fisher-Yates 前缀洗牌：每次从「未被选过的位置」里取
        for (let i = 0; i < 5; i++) {
          const j = i + ((Math.random() * (48 - i)) | 0);
          const tt = idx[i]; idx[i] = idx[j]; idx[j] = tt;
        }
        for (let i = 0; i < 5; i++) board[i] = rest[idx[i]];
        playOne();
      }
    } else {
      // 完整枚举 C(48,5) = 1,712,304
      for (let i = 0; i < 48; i++) for (let j = i + 1; j < 48; j++) for (let k = j + 1; k < 48; k++)
        for (let l = k + 1; l < 48; l++) for (let m = l + 1; m < 48; m++) {
          board[0] = rest[i]; board[1] = rest[j]; board[2] = rest[k]; board[3] = rest[l]; board[4] = rest[m];
          playOne();
        }
    }
    return { eq: (winA + tie / 2) / n * 100, n, mismatch, fast: FAST };
  }

  const r1 = exhaustive('AsKs', 'QhQd');
  ok('枚举 AsKs vs QhQd（' + r1.n.toLocaleString() + ' 局，交叉验证 ' + r1.mismatch + ' 分歧）',
     r1.mismatch === 0 && Math.abs(r1.eq - 46.2) < (FAST ? 0.8 : 0.1), r1.eq.toFixed(3) + '%');

  const r2 = exhaustive('AsAh', 'KcKd');
  ok('枚举 AsAh vs KcKd（交叉验证 ' + r2.mismatch + ' 分歧）',
     r2.mismatch === 0 && Math.abs(r2.eq - 81.3) < (FAST ? 0.8 : 0.1), r2.eq.toFixed(3) + '%');

  // 范围 vs 范围
  const cases = [
    ['AA', 'all', '', 85.2, 'AA vs 随机'],
    ['AKs', 'all', '', 67.4, 'AKs vs 随机'],
    ['22', 'all', '', 50.4, '22 vs 随机'],
    ['AA', 'KK', '', 81.3, 'AA vs KK'],
    ['72o', 'AA', '', 11.5, '72o vs AA'],
    ['AKs', 'AKo', '', 52.8, 'AKs vs AKo（大量平局）']
  ];
  cases.forEach(([a, b, bd, want, label]) => {
    const board = G.parseCards(bd);
    const dead = new Uint8Array(52);
    board.forEach(c => dead[c] = 1);
    const A = G.toCombos(G.expandRange(a), dead);
    const B = G.toCombos(G.expandRange(b), dead);
    const r = G.simulate(A, B, board, FAST ? 20000 : 60000);
    const eq = r.equityA * 100;
    ok(label, Math.abs(eq - want) < 1.7, eq.toFixed(2) + '% vs 参考 ' + want + '%');
  });

  // 固定底牌 vs 范围
  const eqAA = G.equityVsRange(G.parseCards('Ah As'), G.toCombos(G.expandRange('KK,QQ,AK'), null), [], 20000);
  ok('AA vs {KK,QQ,AK}', Math.abs(eqAA - 0.855) < 0.03, (eqAA * 100).toFixed(2) + '%');

  const eqAK = G.equityVsRange(
    G.parseCards('Ac Kc'),
    G.toCombos(G.expandRange('22+,A2s+,KTs+,QTs+,JTs,ATo+,KTo+,QJo'), null),
    G.parseCards('Ah 7d 2c'), 15000);
  ok('AK 在 A72 压顶对', eqAK > 0.85, (eqAK * 100).toFixed(2) + '%');

  // 阻断
  const dead = new Uint8Array(52);
  G.parseCards('As Kh 7d').forEach(c => dead[c] = 1);
  ok('板 AsKh7d 下 AA 剩 3 组合', G.toCombos(G.expandRange('AA'), dead).length === 3);
  ok('板 AsKh7d 下全范围 1176', G.toCombos(G.expandRange('all'), dead).length === 1176);

  const dead5 = new Uint8Array(52);
  G.parseCards('As Kh 7d 2c 9s').forEach(c => dead5[c] = 1);
  ok('河牌 5 张下全范围 1081', G.toCombos(G.expandRange('all'), dead5).length === 1081);

  // 权益表
  const tbl = G.handEquityTable();
  ok('权益表 169 手', Object.keys(tbl).length === 169, Object.keys(tbl).length);
  const vals = Object.keys(tbl).map(k => tbl[k]);
  ok('AA 最强', Math.max(...vals) === tbl['AA'], (tbl['AA'] * 100).toFixed(1) + '%');
  ok('32o 最弱', Math.min(...vals) === tbl['32o'], (tbl['32o'] * 100).toFixed(1) + '%');
}

/* ================================================================
 * 4. 牌面分类
 * ================================================================ */
function testBoard() {
  section('4. 牌面分类');

  const t1 = G.classifyBoard(G.parseCards('As 7d 2c'));
  ok('A-7-2 干燥', t1.texture === 'dry');
  ok('A-7-2 无顺子可能', !t1.hasStraightPossible);
  ok('A 高面 PFR 有范围优势', t1.rangeAdv > 0, t1.rangeAdv.toFixed(2));
  ok('A 高面 PFR 有坚果优势', t1.nutAdv > 0, t1.nutAdv.toFixed(2));

  const t2 = G.classifyBoard(G.parseCards('7h 6d 5c'));
  ok('7-6-5 湿润', t2.texture === 'wet');
  ok('7-6-5 有顺子可能', t2.hasStraightPossible);
  ok('低连面 PFR 坚果劣势', t2.nutAdv < 0, t2.nutAdv.toFixed(2));

  const t3 = G.classifyBoard(G.parseCards('Kh Kd 7c'));
  ok('K-K-7 对子面', t3.isPaired);
  ok('K-K-7 无顺子可能', !t3.hasStraightPossible);

  const t4 = G.classifyBoard(G.parseCards('9s 8s 2s'));
  ok('9-8-2 单色', t4.suitType === 'monotone');

  const t5 = G.classifyBoard(G.parseCards('Ah 2d 3c'));
  ok('A-2-3 有轮子潜力', t5.hasStraightPossible, 'potential=' + t5.potential);

  const t6 = G.classifyBoard(G.parseCards('Jh 7d 3c'));
  ok('J-7-3 彩虹', t6.suitType === 'rainbow');

  const t7 = G.classifyBoard(G.parseCards('Qs Qd Qh'));
  ok('Q-Q-Q 三条面', t7.isTrips);
}

/* ================================================================
 * 5. 决策合法性与合理性
 * ================================================================ */
function testDecisions() {
  section('5. 决策');

  function adv(st) { return G.advise(st); }

  // --- 翻前正确性 ---
  const pre = [
    [{ pos: 'UTG', cards: cardsOf('AA') }, 'raise', 'UTG AA 加注'],
    [{ pos: 'UTG', cards: cardsOf('72o') }, 'fold', 'UTG 72o 弃牌'],
    [{ pos: 'UTG', cards: cardsOf('A2o') }, 'fold', 'UTG A2o 弃牌'],
    [{ pos: 'UTG', cards: cardsOf('22') }, 'fold', 'UTG 22 弃牌'],
    [{ pos: 'UTG', cards: cardsOf('55') }, 'raise', 'UTG 55 加注'],
    [{ pos: 'BTN', cards: cardsOf('A2o') }, 'raise', 'BTN A2o 加注'],
    [{ pos: 'BTN', cards: cardsOf('72o') }, 'fold', 'BTN 72o 弃牌'],
    [{ pos: 'CO', cards: cardsOf('54s') }, 'raise', 'CO 54s 加注'],
  ];
  pre.forEach(([h, want, label]) => {
    const d = adv({ street: 'preflop', hero: Object.assign({ stack: 100 }, h), pot: 1.5 });
    ok(label, d.action === want, d.actionCN + ' / want ' + want);
  });

  const d3 = adv({ street: 'preflop', hero: { pos: 'BB', cards: cardsOf('AA'), stack: 100, invested: 1 },
    villainPos: 'BTN', pot: 4, toCall: 1.5, raiseCount: 1 });
  ok('BB AA 面对开池 → 3bet', d3.action === '3bet', d3.actionCN);

  const d4 = adv({ street: 'preflop', hero: { pos: 'CO', cards: cardsOf('AA'), stack: 100 },
    villainPos: 'BTN', pot: 12, toCall: 7, raiseCount: 2 });
  ok('CO AA 面对 3bet → 4bet', d4.action === '4bet', d4.actionCN);

  const d5 = adv({ street: 'preflop', hero: { pos: 'BTN', cards: cardsOf('72o'), stack: 100 },
    villainPos: 'CO', pot: 12, toCall: 7, raiseCount: 2 });
  ok('BTN 72o 面对 3bet → 弃牌', d5.action === 'fold', d5.actionCN);

  const d6 = adv({ street: 'preflop', hero: { pos: 'CO', cards: cardsOf('AA'), stack: 20 },
    villainPos: 'BTN', pot: 12, toCall: 7, raiseCount: 2 });
  ok('20bb 的 AA 面对 3bet → 全下', d6.action === 'allin' || d6.action === '4bet', d6.actionCN);

  // --- 翻后正确性 ---
  const f1 = adv({ street: 'flop', hero: { pos: 'BTN', cards: cardsOf('AKs'), stack: 97, invested: 3 },
    board: 'As 7d 2c', pot: 6, villainPos: 'BB', villainOpenPos: 'BTN' });
  ok('AK 在 A-7-2 → 下注', f1.action === 'bet', f1.actionCN);
  ok('AK 在 A-7-2 尺度 <= 0.5 池', f1.sizing.fraction <= 0.5, f1.sizing.fraction.toFixed(2));

  const f2 = adv({ street: 'flop', hero: { pos: 'BTN', cards: cardsOf('KQs'), stack: 97, invested: 3 },
    board: '7h 6d 5c', pot: 6, villainPos: 'BB', villainOpenPos: 'BTN' });
  ok('KQ 在 7-6-5 → 过牌', f2.action === 'check', f2.actionCN);
  const contradiction = f2.reasons.some(r => r.indexOf('尺度要大') >= 0) &&
                        f2.reasons.some(r => r.indexOf('尺度要小') >= 0);
  ok('7-6-5 无尺度矛盾', !contradiction);

  const f3 = adv({ street: 'flop', hero: { pos: 'BTN', cards: cardsOf('AKs'), stack: 97, invested: 3 },
    board: 'As 7d 2c', pot: 8, toCall: 2, villainPos: 'BB', villainOpenPos: 'BTN' });
  ok('AK 面对 1/3 下注 → 加注/跟注', f3.action === 'raise' || f3.action === 'call', f3.actionCN);

  const f4 = adv({ street: 'flop', hero: { pos: 'BB', cards: cardsOf('72o'), stack: 96, invested: 4 },
    board: 'As Kd 7c', pot: 10, toCall: 4, villainPos: 'BTN', villainOpenPos: 'BTN' });
  ok('BB 72o 在 A-K-7 面对 2/3 下注 → 弃牌', f4.action === 'fold', f4.actionCN);

  // --- 输出契约 ---
  section('6. 输出契约');
  const all = [d3, d4, d5, d6, f1, f2, f3, f4];
  let contractOk = true;
  all.forEach(d => {
    if (!d.action) contractOk = false;
    if (!(typeof d.frequency === 'number' && d.frequency >= 0 && d.frequency <= 1)) contractOk = false;
    if (!Array.isArray(d.reasons) || d.reasons.length < 2) contractOk = false;
    if (!d.actionCN) contractOk = false;
  });
  ok('动作/频率/理由≥2条/中文名 齐全', contractOk);

  const sizedActions = ['bet', 'raise', '3bet', '4bet'];
  const wantsSize = all.filter(d => sizedActions.indexOf(d.action) >= 0);
  ok('下注类动作带尺度', wantsSize.every(d => d.sizing && d.sizing.fraction != null),
    wantsSize.length + ' 例');
  ok('弃牌不带尺度', all.filter(d => d.action === 'fold').every(d => !d.sizing));
}

/* ================================================================
 * 6. 全量扫描
 * ================================================================ */
function testSweep() {
  section('7. 全量扫描');

  const pos = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
  const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  const all169 = [];
  for (let i = 0; i < 13; i++) {
    all169.push(ranks[i] + ranks[i]);
    for (let j = i + 1; j < 13; j++) {
      all169.push(ranks[i] + ranks[j] + 's');
      all169.push(ranks[i] + ranks[j] + 'o');
    }
  }

  const scenes = [
    { toCall: 0, raiseCount: 0 },
    { toCall: 2.5, raiseCount: 1, villainPos: 'MP' },
    { toCall: 2.5, raiseCount: 1, villainPos: 'BTN' },
    { toCall: 8, raiseCount: 2, villainPos: 'CO' },
    { toCall: 8, raiseCount: 2, villainPos: 'CO', stack: 25 },
    { toCall: 8, raiseCount: 2, villainPos: 'CO', stack: 15 }
  ];

  let n = 0;
  const bad = [];
  for (const ps of pos) for (const h of all169) for (const sc of scenes) {
    try {
      const d = G.advise({
        street: 'preflop',
        hero: { pos: ps, cards: cardsOf(h), stack: sc.stack || 100, invested: ps === 'BB' ? 1 : 0 },
        pot: 6, toCall: sc.toCall, raiseCount: sc.raiseCount, villainPos: sc.villainPos
      });
      n++;
      if (!d.action) bad.push(ps + ' ' + h + ' 无动作');
      if (d.reasons.length < 2) bad.push(ps + ' ' + h + ' 理由 ' + d.reasons.length);
      if (!(d.frequency >= 0 && d.frequency <= 1)) bad.push(ps + ' ' + h + ' 频率 ' + d.frequency);
      if (d.action === 'fold' && d.sizing) bad.push(ps + ' ' + h + ' 弃牌带尺度');
      if (['bet', 'raise', '3bet', '4bet'].indexOf(d.action) >= 0 && !d.sizing) bad.push(ps + ' ' + h + ' 缺尺度');
    } catch (e) { bad.push(ps + ' ' + h + ' 异常 ' + e.message); }
  }
  ok('翻前 ' + n + ' 例（6 位置 × 169 手 × 6 场景）', bad.length === 0, bad.length ? bad.slice(0, 5).join(' | ') : '');

  // 翻后：抽样扫（完整跑要 36 秒，这里用较小组合）
  const hands = ['AA', 'KK', 'AKs', 'AQs', 'KQs', 'JTs', '76s', '54s', '22', 'A5s', '72o', 'A2o'];
  const flops = ['As7d2c', '7h6d5c', 'KhKd7c', '9s8s2s', 'Jh7d3c', 'Ah2d3c', 'QsQdQh', 'AdKdQd'];
  const streetsToTest = [
    { tag: '翻牌', board: f => f, street: 'flop' },
    { tag: '转牌', board: f => f + ' 4s', street: 'turn' },
    { tag: '河牌', board: f => f + ' 4s Th', street: 'river' }
  ];
  let n2 = 0;
  const bad2 = [];
  for (const ps of pos) for (const h of hands) for (const bd of flops) for (const st of streetsToTest) {
    for (const facing of [0, 3, 8]) {
      try {
        const d = G.advise({
          street: st.street,
          hero: { pos: ps, cards: cardsOf(h), stack: 96, invested: 4 },
          board: st.board(bd), pot: facing ? facing + 10 : 10, toCall: facing,
          villainPos: 'BTN', villainOpenPos: 'BTN', iterations: 600
        });
        n2++;
        if (!d.action) bad2.push(ps + ' ' + h + ' ' + bd + ' 无动作');
        if (d.reasons.length < 2) bad2.push(ps + ' ' + h + ' ' + bd + ' 理由 ' + d.reasons.length);
        if (!(d.frequency >= 0 && d.frequency <= 1)) bad2.push(ps + ' ' + h + ' ' + bd + ' 频率');
        if (d.sizing && d.sizing.fraction != null && !(d.sizing.fraction >= 0 && d.sizing.fraction < 6)) {
          bad2.push(ps + ' ' + h + ' ' + bd + ' 尺度 ' + d.sizing.fraction);
        }
      } catch (e) { bad2.push(ps + ' ' + h + ' ' + bd + ' 异常 ' + e.message); }
    }
  }
  ok('翻后 ' + n2 + ' 例（3 条街 × 3 种面对下注）', bad2.length === 0, bad2.length ? bad2.slice(0, 5).join(' | ') : '');

  // 边界：非法输入应给出清晰错误
  let threw = false;
  try { G.advise({ street: 'flop', hero: { pos: 'BTN', cards: ['As'] }, board: 'As 7d 2c', pot: 6 }); }
  catch (e) { threw = /两张/.test(e.message); }
  ok('只给一张底牌时报错', threw);
}

/* ================================================================ */
function main() {
  console.log('gto-engine 自测' + (FAST ? '（快速模式）' : ''));
  console.log('版本 ' + G.version + ' | ' + new Date().toISOString().slice(0, 19).replace('T', ' '));

  const t0 = Date.now();
  testBasics();
  testEvaluator();
  testEquity();
  testBoard();
  testDecisions();
  testSweep();

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n' + '─'.repeat(52));
  if (fail === 0) {
    console.log('全部通过：' + pass + ' 项，耗时 ' + sec + 's');
    process.exit(0);
  } else {
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项，耗时 ' + sec + 's');
    console.log('\n失败清单：');
    failures.forEach(f => console.log('  · ' + f));
    process.exit(1);
  }
}

main();
