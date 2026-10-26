/*!
 * validate.js — hand state 接口契约
 * ---------------------------------------------------------------
 * 引擎本身很宽容：位置写错了它不会报错，只会静默按 -1 的索引
 * 去算位置优势，然后给你一个「看起来正常但结论是错」的建议。
 * 对直接写代码的人这很危险，对通过接口接入的游戏客户端更危险——
 * 客户端传错一个字段，日志里全是 200。
 *
 * 所以这一层只做一件事：把「静默算错」全部转成「明确报错」。
 *
 *   https://...  POST /v1/advise  { "hero":{ "pos":"BTN" ... } }
 *                                 ↓
 *   { ok:false, error:{ code:"E_BAD_POSITION", field:"hero.pos",
 *                       message:"...", hint:"..." } }
 * ---------------------------------------------------------------
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../engine/gto-engine.js'));
  } else {
    root.GTOValidate = factory(root.GTOEngine);
  }
})(typeof self !== 'undefined' ? self : this, function (engine) {
'use strict';

const API_VERSION = '1.0';

const STREETS = ['preflop', 'flop', 'turn', 'river'];
const STREET_CN = { preflop: '翻前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };
const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
const BOARD_SIZE = { preflop: 0, flop: 3, turn: 4, river: 5 };
const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise', '3bet', '4bet', 'allin'];
const ACTION_CN = {
  fold: '弃牌', check: '过牌', call: '跟注', bet: '下注',
  raise: '加注', '3bet': '3bet', '4bet': '4bet', allin: '全下'
};

/**
 * 数值边界。上限不是洁癖，是为了防止一次请求把进程卡死：
 * equity 模拟是同步的，iterations 给到 100 万，整个服务就假死了。
 */
const LIMITS = {
  pot:            { min: 0,    max: 1e6 },
  toCall:         { min: 0,    max: 1e6 },
  stack:          { min: 0.01, max: 1e5 },
  invested:       { min: 0,    max: 1e5 },
  effectiveStack: { min: 0,    max: 1e5 },
  numPlayers:     { min: 2,    max: 10 },
  raiseCount:     { min: 0,    max: 10 },
  iterations:     { min: 200,  max: 50000 },
  betFraction:    { min: 0,    max: 20 }
};

const DEFAULTS = {
  stack: 100,
  invested: 0,
  pot: 0,
  toCall: 0,
  numPlayers: 2,
  iterations: 6000
};

/** 单条请求允许的字段；其余字段原样回显，不当错误 */
const KNOWN_FIELDS = [
  'street', 'hero', 'board', 'boardCards', 'heroCards',
  'pot', 'toCall', 'effectiveStack', 'villainPos', 'villainOpenPos',
  'raiseCount', 'numPlayers', 'villainRange', 'villainRaisedPostflop',
  'iterations', 'betFraction', 'seed'
];

/** 给 /v1/meta 用的字段说明表（也是 docs/api.md 的来源） */
const FIELDS = [
  { name: 'street', type: 'enum', values: STREETS, required: false,
    default: '由 board 张数推导', desc: '当前街。不传时按 board 长度自动判断（0/3/4/5 张）。' },
  { name: 'hero.pos', type: 'enum', values: POSITIONS, required: false, default: 'BTN',
    desc: '英雄位置。必须是 6 个位置之一，写错会报 E_BAD_POSITION —— 引擎不会替你兜底。' },
  { name: 'hero.cards', type: 'cards', required: true, default: null,
    desc: '两张手牌，如 ["As","Kc"]。也接受紧凑写法 "AsKc"。' },
  { name: 'hero.stack', type: 'number', required: false, default: 100,
    desc: '英雄剩余后手（bb）。' },
  { name: 'hero.invested', type: 'number', required: false, default: 0,
    desc: '英雄本手已投入（bb）。用于计算 SPR 与后续街的筹码深度。' },
  { name: 'board', type: 'cards', required: false, default: [],
    desc: '公共牌。翻前省略，翻牌 3 张，转牌 4 张，河牌 5 张。必须与 street 匹配。' },
  { name: 'pot', type: 'number', required: false, default: 0,
    desc: '当前底池总额（bb），含对手本次下注。跟注所需权益 = toCall / (pot + toCall)。' },
  { name: 'toCall', type: 'number', required: false, default: 0,
    desc: '你需要跟注的额度（bb）。0 表示无下注面对你，动作集合为 check/bet。' },
  { name: 'effectiveStack', type: 'number', required: false, default: 'hero.stack',
    desc: '有效筹码（bb）。与 hero.stack 分开是为了处理「你深、对手浅」。' },
  { name: 'villainPos', type: 'enum', values: POSITIONS, required: false, default: null,
    desc: '对手位置。影响范围估算与位置优势判断。' },
  { name: 'villainOpenPos', type: 'enum', values: POSITIONS, required: false, default: null,
    desc: '对手开池位置。面对 3bet 时用它比 villainPos 更准。' },
  { name: 'raiseCount', type: 'number', required: false, default: 'toCall>0 ? 1 : 0',
    desc: '本街加注次数。1 = 面对开池，2 = 面对 3bet，3 = 面对 4bet。' },
  { name: 'numPlayers', type: 'number', required: false, default: 2,
    desc: '入池人数。引擎按单挑处理，>2 时会在 warnings 里提示精度下降。' },
  { name: 'villainRange', type: 'string|array', required: false, default: null,
    desc: '对手范围，如 "AA,KK,AKs,AQo+,76s" 或 ["AA","AKs"]。不传则按位置自动估算。' },
  { name: 'villainRaisedPostflop', type: 'boolean', required: false, default: false,
    desc: '对手是否在翻后加注过。影响诈唬与抓诈唬的判断。' },
  { name: 'iterations', type: 'number', required: false, default: 6000,
    desc: '权益抽样次数，200 ~ 50000。越高越准越慢，6000 约 ±1.5%，20000 约 ±0.8%。' },
  { name: 'betFraction', type: 'number', required: false, default: '由 toCall/pot 推导',
    desc: '对手下注占池比例。用于算 MDF/Alpha，一般不用传。' },
  { name: 'seed', type: 'number|string', required: false, default: '服务端生成',
    desc: '随机种子。同一个 seed 得到完全相同的权益数值，便于复盘对齐与测试断言。' }
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** "As Kh 7d" / "AsKh7d" / "As,Kh,7d" -> ["As","Kh","7d"]；长度奇数返回 null */
function splitCardString(s) {
  const t = String(s).replace(/[\s,;]+/g, '');
  if (t.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < t.length; i += 2) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 读一组牌，任何问题都写进 errors 并返回已解析的部分。
 * 不会抛异常 —— 校验层的工作是收集所有问题一次报完，而不是遇到第一个就中断。
 */
function readCards(input, field, errors) {
  if (input === undefined || input === null) return [];

  let list;
  if (typeof input === 'string') {
    list = splitCardString(input);
    if (list === null) {
      errors.push({
        code: 'E_BAD_CARD_FORMAT', field,
        message: '紧凑牌面字符串的字符数必须是偶数（每张牌两个字符）',
        hint: '正确写法："AsKh7d" 或 "As Kh 7d"'
      });
      return [];
    }
  } else if (Array.isArray(input)) {
    list = input;
  } else {
    errors.push({
      code: 'E_FIELD_TYPE', field,
      message: '应为字符串数组或紧凑字符串',
      hint: '例如 ["As","Kc"] 或 "AsKc"'
    });
    return [];
  }

  const cards = [];
  const seen = new Map();

  list.forEach((c, i) => {
    const at = Array.isArray(list) ? field + '[' + i + ']' : field;
    if (typeof c !== 'string') {
      errors.push({ code: 'E_FIELD_TYPE', field: at, message: '牌必须是字符串', hint: '例如 "As"' });
      return;
    }
    const code = engine.parseCard(c);
    if (code < 0) {
      errors.push({
        code: 'E_BAD_CARD', field: at,
        message: '无法解析的牌："' + c + '"',
        hint: '点数 2-9 TJQKA + 花色 s/h/d/c，例如 "Ac"、"Th"、"9d"'
      });
      return;
    }
    if (seen.has(code)) {
      errors.push({
        code: 'E_DUP_CARD', field: at,
        message: '重复的牌："' + c + '" 已经出现过（' + seen.get(code) + '）',
        hint: '同一张牌不能在牌堆里出现两次'
      });
      return;
    }
    seen.set(code, at);
    cards.push(code);
  });

  return cards;
}

/** 读数值字段：缺省用 dflt，非法写 error，越界写 error */
function readNumber(obj, key, field, dflt, errors) {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!isFinite(n)) {
    errors.push({
      code: 'E_FIELD_TYPE', field,
      message: '应为数字，收到 ' + JSON.stringify(raw),
      hint: '字符串 "6.5" 可以，null 视作未传'
    });
    return dflt;
  }
  const lim = LIMITS[key];
  if (lim) {
    if (n < lim.min || n > lim.max) {
      errors.push({
        code: 'E_OUT_OF_RANGE', field,
        message: '取值 ' + n + ' 超出允许范围 [' + lim.min + ', ' + lim.max + ']',
        hint: key === 'iterations'
          ? '6000 约 ±1.5%，20000 约 ±0.8%；再高会明显变慢'
          : null
      });
      return dflt;
    }
  }
  return n;
}

function readPosition(obj, key, field, errors) {
  const raw = obj[key];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    errors.push({ code: 'E_BAD_POSITION', field, message: '位置必须是字符串', hint: '例如 "BTN"' });
    return null;
  }
  const pos = raw.toUpperCase();
  if (POSITIONS.indexOf(pos) < 0) {
    errors.push({
      code: 'E_BAD_POSITION', field,
      message: '未知位置："' + raw + '"',
      hint: '可选：' + POSITIONS.join(' / ') + '（引擎不会替你兜底非法位置，只会算错）'
    });
    return null;
  }
  return pos;
}

/** 范围字符串能否被引擎解析成非空组合集 */
function readRange(input, field, errors, deadCards) {
  if (input === undefined || input === null || input === '') return null;

  let compact;
  if (typeof input === 'string') compact = input;
  else if (Array.isArray(input) && input.every(x => typeof x === 'string')) compact = input.join(',');
  else {
    errors.push({
      code: 'E_FIELD_TYPE', field,
      message: '范围应为字符串或字符串数组',
      hint: '例如 "AA,KK,AKs,ATs+,76s"'
    });
    return null;
  }

  let hands;
  try {
    hands = engine.expandRange(compact);
  } catch (e) {
    errors.push({
      code: 'E_BAD_RANGE', field,
      message: '范围解析失败：' + e.message,
      hint: '支持写法：AA、AKs、AKo、ATs+、T9s-76s、AXs'
    });
    return null;
  }

  if (!hands || hands.size === 0) {
    errors.push({
      code: 'E_BAD_RANGE', field,
      message: '范围解析结果为空',
      hint: '检查是否有拼写错误，例如把 AKs 写成 AKss'
    });
    return null;
  }

  const dead = new Uint8Array(52);
  (deadCards || []).forEach(c => { dead[c] = 1; });
  const combos = engine.toCombos(hands, dead);
  if (combos.length === 0) {
    errors.push({
      code: 'E_RANGE_BLOCKED', field,
      message: '这个范围与已知牌完全冲突（组合数为 0）',
      hint: '确认 villainRange 里没有包含 hero/board 上已经出现的牌'
    });
    return null;
  }

  return compact;
}

/* ------------------------------------------------------------------ */
/* 主校验                                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {*} raw 请求体
 * @param {object} [opts]
 * @param {string} [opts.prefix] 错误 field 字段的前缀（batch 里用）
 * @returns {{ok:boolean, value:object|null, errors:Array, warnings:Array}}
 */
function validate(raw, opts) {
  opts = opts || {};
  const errors = [];
  const warnings = [];

  if (!isPlainObject(raw)) {
    errors.push({
      code: 'E_NOT_OBJECT', field: '$',
      message: '请求体必须是一个 JSON 对象',
      hint: '例如 {"hero":{"pos":"BTN","cards":["As","Kc"]},"street":"preflop"}'
    });
    return { ok: false, value: null, errors, warnings };
  }

  const hero = raw.hero;
  const heroObj = isPlainObject(hero) ? hero : {};

  // ---- 手牌（唯一必填项）----
  const heroCardsRaw = heroObj.cards !== undefined ? heroObj.cards
    : (raw.heroCards !== undefined ? raw.heroCards : undefined);

  if (heroCardsRaw === undefined) {
    errors.push({
      code: 'E_MISSING_FIELD', field: 'hero.cards',
      message: '缺少手牌，这是唯一的必填字段',
      hint: '{"hero":{"pos":"BTN","cards":["As","Kc"]}}'
    });
  }

  let heroCards = readCards(heroCardsRaw, 'hero.cards', errors);
  if (heroCardsRaw !== undefined && heroCards.length !== 2) {
    if (heroCards.length < 2 && !errors.some(e => e.field.indexOf('hero.cards') === 0)) {
      errors.push({
        code: 'E_CARD_COUNT', field: 'hero.cards',
        message: '手牌必须是 2 张，收到 ' + heroCards.length + ' 张',
        hint: '德州扑克每人两张底牌'
      });
    }
  }

  // ---- 公共牌 ----
  const boardRaw = raw.board !== undefined ? raw.board : raw.boardCards;
  const board = readCards(boardRaw, 'board', errors);

  if (boardRaw !== undefined && [0, 3, 4, 5].indexOf(board.length) < 0) {
    if (!errors.some(e => e.field.indexOf('board') === 0)) {
      errors.push({
        code: 'E_BOARD_SIZE', field: 'board',
        message: '公共牌必须是 3 / 4 / 5 张（翻前不传），收到 ' + board.length + ' 张',
        hint: '翻牌圈 3 张、转牌圈 4 张、河牌圈 5 张。少于 3 张只能视为翻前。'
      });
    }
  }

  // 手牌与公共牌冲突
  const heroSet = new Set(heroCards);
  board.forEach((c, i) => {
    if (heroSet.has(c)) {
      errors.push({
        code: 'E_CARD_CONFLICT', field: 'board[' + i + ']',
        message: '公共牌 ' + engine.cardStr(c) + ' 与手牌重复',
        hint: '这手牌的数据源拼接可能出了错'
      });
    }
  });

  // ---- 街 ----
  let street = null;
  if (raw.street !== undefined && raw.street !== null && raw.street !== '') {
    if (typeof raw.street !== 'string') {
      errors.push({ code: 'E_FIELD_TYPE', field: 'street', message: '应为字符串', hint: STREETS.join(' / ') });
    } else {
      const s = raw.street.toLowerCase();
      if (STREETS.indexOf(s) < 0) {
        errors.push({
          code: 'E_BAD_STREET', field: 'street',
          message: '未知街道："' + raw.street + '"',
          hint: '可选：' + STREETS.join(' / ')
        });
      } else {
        street = s;
        const need = BOARD_SIZE[s];
        if (board.length !== need) {
          errors.push({
            code: 'E_STREET_MISMATCH', field: 'street',
            message: 'street="' + s + '" 需要 ' + need + ' 张公共牌，实际 ' + board.length + ' 张',
            hint: '要么改正 street，要么补齐 board。这个不一致会让引擎走错分支，结果不可用。'
          });
        }
      }
    }
  } else {
    street = board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : board.length === 3 ? 'flop' : 'preflop';
  }

  // ---- 位置 ----
  const heroPos = readPosition(heroObj, 'pos', 'hero.pos', errors) || 'BTN';
  const villainPos = readPosition(raw, 'villainPos', 'villainPos', errors);
  const villainOpenPos = readPosition(raw, 'villainOpenPos', 'villainOpenPos', errors);

  // ---- 数值 ----
  const stack = readNumber(heroObj, 'stack', 'hero.stack', DEFAULTS.stack, errors);
  const invested = readNumber(heroObj, 'invested', 'hero.invested', DEFAULTS.invested, errors);
  const pot = readNumber(raw, 'pot', 'pot', DEFAULTS.pot, errors);
  const toCall = readNumber(raw, 'toCall', 'toCall', DEFAULTS.toCall, errors);
  const numPlayers = readNumber(raw, 'numPlayers', 'numPlayers', DEFAULTS.numPlayers, errors);
  const iterations = readNumber(raw, 'iterations', 'iterations', DEFAULTS.iterations, errors);
  const betFraction = readNumber(raw, 'betFraction', 'betFraction', null, errors);

  const effectiveRaw = raw.effectiveStack;
  const effectiveStack = (effectiveRaw === undefined || effectiveRaw === null || effectiveRaw === '')
    ? stack
    : readNumber(raw, 'effectiveStack', 'effectiveStack', stack, errors);

  let raiseCount;
  if (raw.raiseCount === undefined || raw.raiseCount === null || raw.raiseCount === '') {
    raiseCount = toCall > 0 ? 1 : 0;
  } else {
    raiseCount = readNumber(raw, 'raiseCount', 'raiseCount', toCall > 0 ? 1 : 0, errors);
  }

  // ---- 语义警告（不阻断，但要说）----
  if (invested > stack) {
    warnings.push({
      code: 'W_INVESTED_GT_STACK', field: 'hero.invested',
      message: '已投入 ' + invested + 'bb 大于后手 ' + stack + 'bb，SPR 会算成负值'
    });
  }
  if (toCall > pot && pot >= 0) {
    warnings.push({
      code: 'W_TOCALL_GT_POT', field: 'toCall',
      message: 'toCall(' + toCall + ') > pot(' + pot + ')。接口约定 pot 已含对手本次下注，'
        + '若你传的是「下注前的底池」，跟注赔率会被低估。'
    });
  }
  if (numPlayers > 2) {
    warnings.push({
      code: 'W_MULTIWAY', field: 'numPlayers',
      message: '多人池：引擎按单挑建模，第 3 名之后的玩家只被当作「底池里的死钱」，'
        + '实际权益会被高估。'
    });
  }
  if (iterations < 3000) {
    warnings.push({
      code: 'W_LOW_ITERATIONS', field: 'iterations',
      message: 'iterations=' + iterations + ' 时权益误差约 ±2%，只适合快速预览。'
    });
  }

  // 翻前最经典的接口误用：把「补大盲」当成「面对加注」
  if (street === 'preflop' && toCall > 0 && toCall <= 1 && pot <= 2.5
      && raw.raiseCount === undefined) {
    warnings.push({
      code: 'W_PREFLOP_TO_CALL_TRAP', field: 'toCall',
      message: '翻前 toCall=' + toCall + '、pot=' + pot + ' 有两种可能：'
        + '① 前面无人入池，你只是想开池 —— 此时应传 toCall:0；'
        + '② 你真的面对一次最小加注。'
        + '引擎按 ② 处理（会给出 3bet/跟注/弃牌），若实际是 ① 请把 toCall 改成 0。'
    });
  }

  // ---- 对手范围 ----
  const villainRange = readRange(raw.villainRange, 'villainRange', errors, heroCards.concat(board));

  // ---- 其它 ----
  const villainRaisedPostflop = !!raw.villainRaisedPostflop;

  // ---- 未识别字段：回显，不当错误 ----
  const echo = {};
  Object.keys(raw).forEach(k => {
    if (KNOWN_FIELDS.indexOf(k) < 0 && k !== 'hero') echo[k] = raw[k];
  });
  if (isPlainObject(raw.hero)) {
    Object.keys(raw.hero).forEach(k => {
      if (['pos', 'cards', 'stack', 'invested'].indexOf(k) < 0) echo['hero.' + k] = raw.hero[k];
    });
  }

  if (errors.length) {
    return { ok: false, value: null, errors, warnings };
  }

  const value = {
    street,
    hero: { pos: heroPos, cards: heroCards, stack, invested },
    boardCards: board,
    pot, toCall, effectiveStack, numPlayers, iterations, raiseCount,
    villainPos, villainOpenPos, villainRange, villainRaisedPostflop
  };
  if (betFraction !== null) value.betFraction = betFraction;

  return { ok: true, value, errors, warnings, echo };
}

  return {
    API_VERSION, STREETS, STREET_CN, POSITIONS, BOARD_SIZE, ACTIONS, ACTION_CN,
    LIMITS, DEFAULTS, FIELDS, KNOWN_FIELDS,
    validate, readCards, splitCardString
  };
});
