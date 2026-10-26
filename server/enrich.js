/*!
 * enrich.js — 把决策结果翻译成教学语言
 * ---------------------------------------------------------------
 * 引擎输出的是机器友好的字段：
 *   { action:'bet', sizing:{fraction:0.66,absolute:4.0,unit:'pot'},
 *     frequency:0.85, confidence:'high', metrics:{equity:0.482,...} }
 *
 * 游戏客户端要展示给学员，就得变成：
 *   "翻牌圈 A♠7♦2♣ ｜ BTN AKs → 下注 66% 池（4.0bb）"
 *   "权益 48.2%，需要 25.0%，多出 23.2pp"
 *
 * 这一层只做翻译和算术，不新增任何策略判断 —— 所有结论都能
 * 追回到引擎输出的某个字段。
 * ---------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../engine/gto-engine.js'));
  } else {
    root.GTOEnrich = factory(root.GTOEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (engine) {
'use strict';

const METRIC_META = {
  equity:  { label: '权益',    kind: 'pct', desc: '对当前估算对手范围的胜率' },
  potOdds: { label: '所需权益', kind: 'pct', desc: '跟注的盈亏平衡点：toCall / (pot + toCall)' },
  mdf:     { label: 'MDF',     kind: 'pct', desc: '最低防守频率，弃牌率超过 1-MDF 就会被剥削' },
  betFreq: { label: '下注频率', kind: 'pct', desc: '该节点基线的建议下注频率' },
  spr:     { label: 'SPR',     kind: 'num', desc: '后手筹码 / 底池' }
};

function pct(v) { return (v * 100).toFixed(1) + '%'; }

/** 把 sizing 渲染成人话：'到 2.3bb' / '66% 池（4.0bb）' */
function sizingText(sizing) {
  if (!sizing) return null;
  if (sizing.unit === 'bb') return '到 ' + sizing.absolute.toFixed(1) + 'bb';
  const f = Math.round(sizing.fraction * 100);
  return f + '% 池（' + sizing.absolute.toFixed(1) + 'bb）';
}

function frequencyNote(f, actionCN) {
  if (f >= 0.95) return '接近纯策略：' + actionCN + ' 几乎总是正确。';
  if (f >= 0.7) return '主频动作：' + actionCN + ' 占 ' + pct(f) + '，可以直接记。';
  if (f >= 0.4) return '混合节点：以 ' + pct(f) + ' 的频率' + actionCN + '，其余走替代线。只看动作会漏掉一半信息。';
  return '低频混合：' + actionCN + ' 只占 ' + pct(f) + '，多数时候应该选别的线 —— 这是个陷阱题。';
}

function confidenceNote(c) {
  if (c === 'high') return '高：该类牌面在基线里分层清晰，可以照做。';
  if (c === 'medium') return '中：落在混合区间，重点理解理由而不是背动作。';
  return '低：引擎只给方向，尺度需要结合对手实际倾向调整。';
}

function practiceTip(st, decision, handClass) {
  if (st.street === 'preflop') {
    return '先别看答案：' + st.hero.pos + ' 位拿着 ' + handClass + '，'
      + (st.toCall > 0 ? '面对加注' : '前面无人入池') + '，你会怎么做？'
      + '说出动作后再展开对照，记忆强度大约是不猜直接看的 3 倍。';
  }
  return '遮住结论，只看牌面 ' + st.boardCards.map(c => engine.cardPretty(c)).join(' ')
    + ' 和赔率，先说出你的动作与尺度，再展开对照。'
    + (decision.mixed ? '（这手是混合节点，动作本身不是唯一答案。）' : '');
}

/** 抽样精度：p≈0.5 时标准误 0.5/√n，取 95% 置信区间 */
function samplingError(iterations) {
  const se = 0.5 / Math.sqrt(Math.max(iterations, 1));
  return '±' + (se * 2 * 100).toFixed(1) + '%';
}

function assumptions(st, decision) {
  const out = [];

  out.push('对手范围：' + (st.villainRange
    ? '按传入的 ' + st.villainRange
    : '按 ' + (st.villainPos || st.villainOpenPos || '默认') + ' 位置的基线范围估算'));

  out.push('权益抽样 ' + (st.iterations || 6000) + ' 次，95% 置信区间约 '
    + samplingError(st.iterations || 6000));

  if (st.numPlayers > 2) {
    out.push('多人池 ' + st.numPlayers + ' 人：引擎按单挑建模，其余玩家只当死钱，权益会偏高。');
  } else {
    out.push('单挑模型（无 ICM、无抽水、无 ante 差异）。');
  }

  if (decision.metrics && decision.metrics.mdf !== undefined) {
    out.push('MDF/Alpha 基于对手本次下注尺度，不含后续街的下注。');
  }

  return out;
}

/**
 * @param {object} st 校验后的 hand state（validate 的 value，含 handClass）
 * @param {object} decision 引擎输出
 * @returns {object} 展示层结构
 */
function enrich(st, decision) {
  const acts = decision.actionCN || decision.action;
  const handClass = engine.handClass(st.hero.cards[0], st.hero.cards[1]);

  // ---- 指标 ----
  const metrics = [];
  const m = decision.metrics || {};
  ['equity', 'potOdds', 'mdf', 'betFreq', 'spr'].forEach(k => {
    if (m[k] === undefined) return;
    const meta = METRIC_META[k];
    metrics.push({
      key: k,
      label: meta.label,
      value: m[k],
      display: meta.kind === 'pct' ? pct(m[k]) : m[k].toFixed(2),
      desc: meta.desc
    });
  });

  // ---- 权益差（纯算术，正数说明跟注有利）----
  let edge = null;
  if (m.equity !== undefined && m.potOdds !== undefined && m.potOdds > 0) {
    const d = m.equity - m.potOdds;
    edge = {
      value: d,
      display: (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + 'pp',
      note: d >= 0
        ? '比盈亏平衡点多出 ' + (d * 100).toFixed(1) + ' 个百分点，跟注本身是正 EV。'
        : '低于盈亏平衡点 ' + Math.abs(d * 100).toFixed(1) + ' 个百分点，纯跟注是负 EV。'
    };
  }

  // ---- 一句话结论 ----
  let scene;
  if (st.street === 'preflop') {
    scene = '翻前';
  } else {
    scene = (st.street === 'flop' ? '翻牌圈' : st.street === 'turn' ? '转牌圈' : '河牌圈')
      + ' ' + st.boardCards.map(c => engine.cardPretty(c)).join(' ');
  }

  const actionPart = decision.sizing ? acts + ' ' + sizingText(decision.sizing) : acts;
  const headline = scene + '｜' + st.hero.pos + ' ' + handClass + ' → ' + actionPart;

  return {
    headline,
    scene,
    handClass,
    action: decision.action,
    actionCN: acts,
    sizingText: sizingText(decision.sizing),
    frequency: decision.frequency,
    frequencyPct: pct(decision.frequency),
    frequencyNote: frequencyNote(decision.frequency, acts),
    confidence: decision.confidence,
    confidenceNote: confidenceNote(decision.confidence),
    metrics,
    edge,
    board: decision.board || null,
    reasons: decision.reasons || [],
    practiceTip: practiceTip(st, decision, handClass),
    assumptions: assumptions(st, decision)
  };
}

  return { enrich, METRIC_META, samplingError };
});
