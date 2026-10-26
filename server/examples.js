/*!
 * examples.js — 标准请求样例
 * ---------------------------------------------------------------
 * 既是 /v1/examples 的返回值，也是调试台的预设按钮来源。
 * 浏览器里也能直接加载（UMD），所以调试台不用再发一次请求去拿它。
 *
 * 每个例子内部数值自洽：能拿计算器核对（pot 含对手本次下注、
 * stack + invested ≈ 100bb）。
 * ---------------------------------------------------------------
 */
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GTOExamples = factory();
})(typeof self !== 'undefined' ? self : this, function () {

const EXAMPLES = [
  {
    id: 'preflop-btn-open',
    name: '翻前 · BTN 开池',
    note: '无人入池。注意 toCall 传 0 —— 引擎据此判断「我是 RFI」，而不是「我在面对加注」。',
    state: {
      street: 'preflop',
      hero: { pos: 'BTN', cards: ['Ac', 'Kc'], stack: 100, invested: 0 },
      pot: 1.5, toCall: 0, numPlayers: 6, villainPos: 'BB'
    }
  },
  {
    id: 'preflop-bb-vs-btn',
    name: '翻前 · BB 防守 BTN 开池',
    note: 'BTN 加注到 2.3bb，底池 3.8bb，BB 需补 1.3bb —— 赔率极便宜。',
    state: {
      street: 'preflop',
      hero: { pos: 'BB', cards: ['9h', '8h'], stack: 97.7, invested: 1 },
      pot: 3.8, toCall: 1.3, numPlayers: 2,
      villainPos: 'BTN', villainOpenPos: 'BTN', raiseCount: 1
    }
  },
  {
    id: 'preflop-btn-vs-3bet',
    name: '翻前 · BTN 面对 3bet',
    note: 'raiseCount:2 表示本街已有两次加注，引擎据此走 4bet / 跟注 / 弃牌分支。',
    state: {
      street: 'preflop',
      hero: { pos: 'BTN', cards: ['Ad', 'Qd'], stack: 97.7, invested: 2.3 },
      pot: 11.8, toCall: 6.7, numPlayers: 2,
      villainPos: 'BB', villainOpenPos: 'BB', raiseCount: 2
    }
  },
  {
    id: 'flop-tptk-cbet',
    name: '翻牌 · 顶对顶踢 cbet',
    note: 'A 高彩虹面，AK 击中顶对顶踢。toCall:0 表示对手已过牌，轮到你行动。',
    state: {
      street: 'flop',
      hero: { pos: 'BTN', cards: ['Ac', 'Kc'], stack: 97.7, invested: 2.3 },
      board: ['As', '7d', '2c'],
      pot: 5.1, toCall: 0, numPlayers: 2, villainPos: 'BB'
    }
  },
  {
    id: 'flop-flushdraw-face-bet',
    name: '翻牌 · 同花听牌面对下注',
    note: '底池 5.1，对手下注 4（约 78% 池），底池变 9.1，需跟 4 —— 跟注赔率 30.5%。',
    state: {
      street: 'flop',
      hero: { pos: 'BB', cards: ['9h', '8h'], stack: 97.7, invested: 2.3 },
      board: ['Ah', '7h', '2c'],
      pot: 9.1, toCall: 4, numPlayers: 2, villainPos: 'BTN'
    }
  },
  {
    id: 'turn-overpair-vs-barrel',
    name: '转牌 · 超对面对第二枪',
    note: '9 使顺子成形，QQ 的后手只剩 90bb 左右，SPR 约 6。',
    state: {
      street: 'turn',
      hero: { pos: 'BB', cards: ['Qc', 'Qs'], stack: 90.7, invested: 5.8 },
      board: ['Th', '7d', '2c', '9s'],
      pot: 14.3, toCall: 5.7, numPlayers: 2, villainPos: 'BTN'
    }
  },
  {
    id: 'river-bluffcatch',
    name: '河牌 · 抓诈唬',
    note: '对手河牌打满池（下注 14.3 进 14.3 的池），你需要 33% 权益才能跟。',
    state: {
      street: 'river',
      hero: { pos: 'BB', cards: ['Ac', 'Jd'], stack: 88.5, invested: 11.5 },
      board: ['Kh', 'Jc', '8d', '5s', '2h'],
      pot: 28.6, toCall: 14.3, numPlayers: 2,
      villainPos: 'BTN', villainRaisedPostflop: true
    }
  },
  {
    id: 'river-nuts-value',
    name: '河牌 · 坚果价值下注',
    note: '65s 在 987-K 面上成 9-8-7-6-5 顺子（A-low 之外的普通顺），对手过牌。',
    state: {
      street: 'river',
      hero: { pos: 'BTN', cards: ['6c', '5c'], stack: 40, invested: 60 },
      board: ['9h', '8d', '7c', '2s', 'Kd'],
      pot: 60, toCall: 0, numPlayers: 2, villainPos: 'BB'
    }
  },
  {
    id: 'monotone-board',
    name: '翻牌 · 单色牌面',
    note: '三种纹理里最特殊的一种：牌面三张同花，没有该花色的范围会被极大压缩。',
    state: {
      street: 'flop',
      hero: { pos: 'CO', cards: ['Ah', 'Qc'], stack: 97.7, invested: 2.3 },
      board: ['Th', '6h', '2h'],
      pot: 5.1, toCall: 0, numPlayers: 2, villainPos: 'BB'
    }
  },
  {
    id: 'multiway-pot',
    name: '翻牌 · 三人池',
    note: '验证多人池降级：返回里会带 W_MULTIWAY 警告，说明权益被高估。',
    state: {
      street: 'flop',
      hero: { pos: 'BTN', cards: ['Ad', 'Kd'], stack: 97.7, invested: 2.3 },
      board: ['Ks', '9c', '4h'],
      pot: 8.4, toCall: 0, numPlayers: 3, villainPos: 'BB'
    }
  },
  {
    id: 'error-street-mismatch',
    name: '反例 · 街道与牌面不符',
    note: '故意传错：street 说是转牌却只给 3 张公共牌。用来验证错误码 E_STREET_MISMATCH。',
    state: {
      street: 'turn',
      hero: { pos: 'BTN', cards: ['Ac', 'Kc'], stack: 95, invested: 2.3 },
      board: ['As', '7d', '2c'],
      pot: 5.1, toCall: 0
    }
  }
];

return { EXAMPLES };
});
