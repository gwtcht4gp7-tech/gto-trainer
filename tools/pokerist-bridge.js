#!/usr/bin/env node
/** Pokerist public JSONL -> history-aware advisory panel.
 * --file <jsonl> --warm-start --profiles <json> --log <jsonl>
 * --hero-seat <seat> --port 8899 --solver 8891 --settle 150
 * --replay uses in-memory profiles unless --profiles is explicit.
 * Real stacks are never silently capped. Multiway output is equity, not Nash.
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PlayerProfiles } = require('./player-profiles');
const { HandLedger } = require('./hand-ledger');

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OPT = {
  file: arg('file', null),
  heroSeat: arg('hero-seat', null) === null ? null : Number(arg('hero-seat')),
  port: Number(arg('port', 8790)),
  profiles: arg('profiles', null),
  trainingStatus: arg('training-status', null),
  observations: arg('observations', null),
  reviewStatus: arg('review-status', null),
  warmStart: !!arg('warm-start', false),
  settle: Number(arg('settle', 150)),
  replay: !!arg('replay', false),
  fromStart: !!arg('from-start', false),
  quiet: !!arg('quiet', false),
  log: arg('log', null),
  feedback: arg('feedback', null),
  solver: Number(arg('solver', 8891)),   // 0 = 关闭 GTO solver
  solverBudget: Number(arg('solver-budget', 0)),
  pace: Number(arg('pace', 0)),   // 回放限速（每行间隔 ms），便于观察 GTO
};
if (require.main === module && !OPT.file) {
  console.error('用法: node tools/pokerist-bridge.js --file <live.jsonl> [--replay] [--hero-seat 9]');
  process.exit(2);
}
if (OPT.replay) { OPT.settle = 0; OPT.fromStart = true; }

/* ------------------------------------------------------------------ */
/* 牌面映射                                                            */
/* ------------------------------------------------------------------ */
const SUIT = { SPADES: 's', HEARTS: 'h', DIAMONDS: 'd', CLUBS: 'c' };
const RANK = { 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUIT_CN = { s: '♠', h: '♥', d: '♦', c: '♣' };
const profiles = new PlayerProfiles(OPT.profiles || (OPT.replay ? null : path.join(ROOT, 'runtime', 'player-profiles.json')));
const ledger = new HandLedger(OPT.observations || (profiles.file ? path.join(path.dirname(profiles.file),'observations.jsonl') : null));

function card(c) {
  if (!c || !c.Value || !c.Suite) return null;
  const r = RANK[c.Value.value], s = SUIT[c.Suite.label];
  return r && s ? r + s : null;
}
function pretty(c) { return c ? c[0] + (SUIT_CN[c[1]] || '') : '??'; }
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function fmt(n, d) {
  const x = Number(n) || 0;
  return x.toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
}

/* ------------------------------------------------------------------ */
/* 运行状态                                                            */
/* ------------------------------------------------------------------ */
const S = {
  table: null,            // { deskId, seats, places, minBet, maxBet }
  heroSeat: OPT.heroSeat,
  heroVotes: {},          // 座位推断票数
  heroLocked: OPT.heroSeat !== null,
  expectEcho: false,      // 刚收到 Private 事件，等公开事件回显 Who
  hand: null,
  snapshot: null,
  lastKey: null,
  pending: null,
  advice: [],             // 最近建议（面板用）
  decisionSeq: 0,
  stats: { records: 0, snapshots: 0, decisions: 0, skipped: 0, errors: 0 },
};
let handNo = 0;
let activeSolverReq = null, activeSolverItem = null;
function invalidate(reason) {
  ledger.invalidate();
  const previous = S.currentDecision;
  S.currentDecision = null; S.gto = null; S.pending = null;
  if (S.timer) clearTimeout(S.timer);
  S.timer = null; S.lastKey = null;
  if (previous && activeSolverReq && activeSolverItem && activeSolverItem.decisionId === previous) {
    const payload = JSON.stringify({decisionId:previous});
    const cancel = http.request({host:'127.0.0.1',port:OPT.solver,path:'/cancel',method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}}, res => res.resume());
    cancel.on('error', () => {});
    cancel.end(payload);
    S.stats.cancelledRequests = (S.stats.cancelledRequests || 0) + 1;
    activeSolverReq.destroy();
  }
  pushSSE({ clear: true, reason });
}
function isCurrent(item) { return S.currentDecision === item.decisionId; }


function resetHand() {
  invalidate('新手牌');
  S.hand = {
    no: ++handNo,
    id: null,
    historyComplete: false,
    dealer: null,
    heroCards: null,
    board: [],
    street: 'preflop',
    streetStartPot: 0,
    capturedWagers: {},
    raises: 0,
    bets: 0,
    ante: 0,
    lastAggressor: null,
    heroFolded: false,
    over: false,
    preAggressor: null,     // 'hero' | 'villain'，只看翻前
  };
  S.lastKey = null;
}

/* ------------------------------------------------------------------ */
/* 位置映射                                                            */
/* ------------------------------------------------------------------ */
function seatPositions(seatOrder, dealer) {
  if (!seatOrder.length || !seatOrder.includes(dealer)) return {};
  const i = seatOrder.indexOf(dealer);
  const rot = seatOrder.slice(i).concat(seatOrder.slice(0, i));
  const names = {2: ['BTN', 'BB'], 3: ['BTN', 'SB', 'BB'],
    4: ['BTN', 'SB', 'BB', 'CO'], 5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
    6: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'CO']}[rot.length];
  if (!names) return {};
  return Object.fromEntries(rot.map((seat, k) => [seat, names[k]]));
}
function lockPositions(st) {
  const active = (st.Players || []).filter(p => p.IsPlaying && !p.IsSitout);
  S.hand.seatOrder = (st.SeatPlaces || active.map(p => p.Place))
    .filter(seat => active.some(p => p.Place === seat));
  S.hand.posmap = seatPositions(S.hand.seatOrder, st.DealerPlace);
  const i = S.hand.seatOrder.indexOf(st.DealerPlace);
  S.hand.postflopOrder = S.hand.seatOrder.slice(i + 1).concat(S.hand.seatOrder.slice(0, i + 1));
}

/* ------------------------------------------------------------------ */
/* 事件处理                                                            */
/* ------------------------------------------------------------------ */
const STAGE_STREET = { 0: 'flop', 1: 'turn', 2: 'river' };

function onEvent(rec) {
  const t = rec.event_type;
  const d = rec.data || {};
  S.stats.records++;

  // Match the public echo by type and table; unrelated Who events are not proof.
  if (t === 'PlayerStakeEventArgsPrivate' || t === 'SmallBlindEventArgsPrivate' || t === 'BigBlindEventArgsPrivate') {
    S.expectEcho = {type: t.replace(/Private$/, ''), table: String(d.TableID),
      at: Date.parse((d.Timestamp || {}).utc || rec.observed_at)};
    return;
  }
  if (S.expectEcho && t === S.expectEcho.type && String(d.TableID) === S.expectEcho.table &&
      Math.abs(Date.parse((d.Timestamp || {}).utc || rec.observed_at) - S.expectEcho.at) < 2000 && d.Who != null) {
    S.expectEcho = false;
    if (OPT.heroSeat === null && d.Player && d.Player.m_ID != null) {
      S.heroId = String(d.Player.m_ID);
      S.heroSeat = d.Who;
    }
    if (!S.heroLocked) {
      S.heroVotes[d.Who] = (S.heroVotes[d.Who] || 0) + 1;
      const best = Object.entries(S.heroVotes).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 2) {
        S.heroSeat = Number(best[0]);
        if (best[1] >= 3) S.heroLocked = true;
        note('hero-seat', `本地座位推断为 ${S.heroSeat}（${best[1]} 票）`);
      }
    }
  }

  ledger.event(rec, S.heroId);
  profiles.event(rec, S.hand.board, card);
  if (['NewHandEventArgs', 'PokerStageEventArgs', 'FoldEventArgs', 'CallEventArgs',
       'CheckEventArgs', 'BetEventArgs', 'RaiseEventArgs', 'GameResultEventArgs',
       'GameEndedEventArgs'].includes(t)) invalidate('行动或牌面已更新');
  switch (t) {
    case 'NewHandEventArgs':
      resetHand();
      if (d.TableID) S.table = {...S.table, deskId: d.TableID};
      S.hand.id = profiles.hand && profiles.hand.key;
      S.hand.historyComplete = true;
      S.hand.startPlayers = ((d.State || {}).Players || []).filter(p => p.IsPlaying && !p.IsSitout)
        .map(p => ({id:String(p.m_ID), seat:p.Place, name:p.m_Nick, stack:p.DAmount}));
      lockPositions(d.State || {});
      if (d.DealerPlace != null) S.hand.dealer = d.DealerPlace;
      break;
    case 'PokerStageEventArgs': {
      const st = STAGE_STREET[(d.Stage || {}).value];
      if (st) S.hand.street = st;
      const cs = (d.Cards || []).map(card).filter(Boolean);
      if (cs.length >= 3) S.hand.board = cs;
      else if (cs.length) S.hand.board.push(...cs);
      S.hand.streetStartPot = num(d.PotAmount);
      S.hand.raises = 0;
      S.hand.bets = 0;
      S.hand.lastAggressor = null;
      break;
    }
    case 'RaiseEventArgs':
      S.hand.raises++;
      S.hand.lastAggressor = d.Who;
      if (S.hand.street === 'preflop' && S.heroSeat != null) {
        S.hand.preAggressor = d.Who === S.heroSeat ? 'hero' : 'villain';
      }
      break;
    case 'BetEventArgs':
      S.hand.bets++;
      S.hand.lastAggressor = d.Who;
      break;
    case 'AnteEventArgs':
      S.hand.ante = Math.max(S.hand.ante, num(d.TotalBetAmount) || num(d.LastBet));
      break;
    case 'CardsReadyEventArgsPrivate': {
      const cs = (d.Cards || []).map(card).filter(Boolean);
      if (cs.length === 2) S.hand.heroCards = cs;
      break;
    }
    case 'FoldEventArgs':
      if (d.Who === S.heroSeat) S.hand.heroFolded = true;
      break;
    case 'GameResultEventArgs':
    case 'GameEndedEventArgs':
      S.hand.over = true;
      break;
    default:
      break;
  }
}

function onTableInfo(rec) {
  const d = rec.data || {};
  if (S.table && String(S.table.deskId) !== String(d.ID)) { resetHand(); profiles.hand = null; }
  S.table = {
    deskId: d.ID,
    places: d.Places,
    minBet: num(d.MinBet),
    maxBet: num(d.MaxBet),
  };
  note('table', `桌 ${d.ID} · ${d.Places} 人桌 · 盲注 ${d.MinBet}/${d.MaxBet}`);
}

/* ------------------------------------------------------------------ */
/* 快照 → 决策                                                         */
/* ------------------------------------------------------------------ */
function onSnapshot(rec) {
  S.stats.snapshots++;
  const st = rec.state || {};
  if (S.table && st.DeskID && String(st.DeskID) !== String(S.table.deskId)) {
    resetHand(); profiles.hand = null;
    S.table = { deskId: st.DeskID };
  }
  S.snapshot = rec;
  if (S.heroId && OPT.heroSeat === null) {
    const me = (st.Players || []).find(p => String(p.m_ID) === S.heroId);
    if (me) S.heroSeat = me.Place;
  }
  profiles.observePlayers(st.Players);
  ledger.snapshot(rec, S.heroId);
  S.hand.board = (st.Cards || []).map(card).filter(Boolean);
  for (const p of st.Players || []) S.hand.capturedWagers[String(p.m_ID)] = {
    street:S.hand.street, amount:num(p.TableAmount), folded:!!p.Folded };
  maybeAdvise();
}

function departedWagers(players, history, street, captured, snapshotPot) {
  const present = new Set(players.map(p => String(p.m_ID))), recovered = [];
  for (const [id, evidence] of Object.entries(captured || {})) {
    if (present.has(id) || evidence.street !== street || evidence.amount <= 0 ||
        !history.some(a => a.playerId === id && a.action === 'fold')) continue;
    const live = history.filter(a => a.playerId === id && a.street === street)
      .reduce((sum,a) => sum + (a.action === 'ante' ? a.liveAmount || 0 :
        ['fold','check'].includes(a.action) ? 0 : a.amount), 0);
    if (Math.abs(live-evidence.amount) <= 1e-5) recovered.push({id,amount:live});
  }
  const extra = recovered.reduce((sum,p) => sum+p.amount,0);
  const paid = history.reduce((sum,a) => sum+(['fold','check'].includes(a.action)?0:a.amount),0);
  // Restore only captured, ledger-confirmed money, and only if the entire pot balances.
  return extra > 0 && Math.abs(snapshotPot+extra-paid) <= 1e-5 ? recovered : [];
}

function decisionContext() {
  const rec = S.snapshot, h = S.hand;
  if (!rec || !h || S.warming) return null;
  if (!OPT.replay && rec.observed_at && Date.now() - Date.parse(rec.observed_at) > 15000) return null;
  const st = rec.state || {}, players = st.Players || [];
  const me = players.find(p => p.Place === S.heroSeat);
  if (!st.GameInProgress || st.ResultInProgress || h.over || h.heroFolded ||
      !me || !me.IsPlaying || me.Folded || st.Current !== S.heroSeat) return null;
  const cards = h.heroCards || (st.PrivateCards || []).map(card).filter(Boolean);
  const board = (st.Cards || []).map(card).filter(Boolean);
  const sc = st.StakeConfig || {}, bb = num(sc.BigBlind);
  if (!bb || cards.length !== 2 || ![0, 3, 4, 5].includes(board.length)) return null;
  const involved = players.filter(p => p.IsPlaying && !p.Folded && num(p.CardsCount) > 0);
  if (involved.length < 2) return null;
  const street = {0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river'}[board.length];
  const history = profiles.hand && profiles.hand.key === h.id ? profiles.hand.actions : [];
  const snapshotPot = Math.max(num(sc.Pot), h.streetStartPot) + players.reduce((v, p) => v + num(p.TableAmount), 0);
  const departed = departedWagers(players, history, street, h.capturedWagers, snapshotPot);
  const pot = snapshotPot + departed.reduce((sum,p) => sum+p.amount,0);
  const toCall = num(sc.Call);
  if (pot <= 0 || toCall > pot || num(me.DAmount) <= 0) return null;
  const key = JSON.stringify([h.id || h.no, st.DeskID, street, cards, board, pot, toCall,
    history.length, involved.map(p => [String(p.m_ID), p.Place, p.DAmount, p.TableAmount])]);
  return { key, rec, st, players, involved, me, cards, board, sc, bb, pot, toCall, street, history, departed };
}

function maybeAdvise() {
  if (S.warming) return;
  const p = decisionContext();
  if (!p) { if (S.currentDecision || S.pending) invalidate('当前未轮到自己行动'); return; }
  if (p.key === S.lastKey || (S.pending && p.key === S.pending.key)) return;
  invalidate('决策上下文已改变');
  S.pending = p;
  if (OPT.settle <= 0) { flushPending(); return; }
  S.timer = setTimeout(flushPending, OPT.settle);
}

function flushPending() {
  const pending = S.pending; S.pending = null; S.timer = null;
  if (!pending) return;
  const p = decisionContext();
  if (!p || p.key !== pending.key) { maybeAdvise(); return; }
  if (p.key === S.lastKey) return;
  const h = S.hand;
  if (!h.posmap || !Object.keys(h.posmap).length) lockPositions(p.st);
  const heroPos = h.posmap[S.heroSeat];
  if (!heroPos) { note('error', '无法确定起手位置，跳过'); return; }
  const opponents = p.involved.filter(x => x.Place !== S.heroSeat).map(x => ({
    id: String(x.m_ID), seat: x.Place, name: x.m_Nick, pos: h.posmap[x.Place],
    stackBB: num(x.DAmount) / p.bb, wagerBB: num(x.TableAmount) / p.bb,
    profile: profiles.summary(x.m_ID),
  }));
  const order = h.postflopOrder || [];
  const heroIsOop = opponents.some(x => order.indexOf(S.heroSeat) < order.indexOf(x.seat));
  const rawStackBB = num(p.me.DAmount) / p.bb;
  const history = p.history.map(a => ({...a, amountBB: a.amount / p.bb, totalBB: a.total / p.bb,
    liveAmountBB:a.liveAmount == null ? 0 : a.liveAmount/p.bb,
    moneyLeftBB: a.moneyLeft == null ? null : a.moneyLeft / p.bb}));
  const contributions = {};
  for (const a of history) if (['blind','ante','call','bet','raise'].includes(a.action))
    contributions[a.playerId] = (contributions[a.playerId] || 0) + a.amountBB;
  const participants = S.hand.startPlayers || p.players.filter(x => x.IsPlaying).map(x =>
    ({id:String(x.m_ID),seat:x.Place,name:x.m_Nick,stack:x.DAmount}));
  const playersContext = participants.map(x => {
    const current = p.players.find(y => String(y.m_ID) === x.id);
    return {...x, pos:h.posmap[x.seat], stackBB:current ? num(current.DAmount)/p.bb : Math.max(0,num(x.stack)/p.bb-(contributions[x.id]||0)),
      wagerBB:current ? num(current.TableAmount)/p.bb : 0,
      folded:!p.involved.some(y => String(y.m_ID) === x.id), profile:profiles.summary(x.id)};
  });
  const last = history.filter(a => a.street === p.street && !['blind', 'ante'].includes(a.action)).at(-1);
  S.lastKey = p.key;
  S.heroId = String(p.me.m_ID);
  const item = {
    kind: 'decision', decisionId: String(p.st.DeskID) + ':' + (h.id || h.no) + ':' + (++S.decisionSeq),
    at: new Date().toISOString(), inMs: 0, hand: h.no, handId: h.id,
    historyComplete: h.historyComplete, history, heroId: String(p.me.m_ID),
    fullStreet:true, playersContext, dealerSeat:p.st.DealerPlace,
    minRaiseBB: Math.max(1, (profiles.hand ? profiles.hand.minRaise : p.toCall) / p.bb),
    heroWagerBB: num(p.me.TableAmount) / p.bb,
    street: p.street, board: p.board, heroCards: p.cards, heroPos,
    villainPos: opponents[0].pos, heroIsOop,
    opponentChecked: opponents.length === 1 && last && last.playerId !== String(p.me.m_ID) && last.action === 'check',
    raises: h.raises + h.bets, preflopAggressor: h.preAggressor,
    potBB: round3(p.pot / p.bb), toCallBB: round3(p.toCall / p.bb),
    potChips: p.pot, toCallChips: p.toCall, bbChips: p.bb,
    potReconciliation: {departedPlayers:p.departed, restoredChips:p.departed.reduce((sum,x)=>sum+x.amount,0)},
    stackBB: rawStackBB, rawStackBB, opponents, numPlayers: p.involved.length,
    hasSidePotRisk: opponents.some(x => x.stackBB === 0) || p.toCall / p.bb > rawStackBB,
    action: 'wait', actionCN: '正在分析当前局面', sizing: null, frequency: null,
    confidence: 'low', metrics: {}, flags: [],
    reasons: [h.historyComplete ? '已传入本手从翻前开始的全部公开行动。' : '中途接入：本手早期行动不完整。',
      '对手按玩家 ID 持久记录；样本不足时，统计只轻微影响估计范围。'],
  };
  S.currentDecision = item.decisionId;
  S.stats.decisions++;
  emit(item);
}

function round3(n) { return Math.round(n * 1000) / 1000; }
function clean(o) {
  const out = {};
  Object.keys(o || {}).forEach(k => { if (typeof o[k] === 'number') out[k] = Math.round(o[k] * 10000) / 10000; });
  return out;
}

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[36m', gray: '\x1b[90m',
};

function note(kind, msg) {
  if (!OPT.quiet) console.log(`${C.gray}[${kind}]${C.reset} ${msg}`);
}

function emit(item) {
  ledger.decision(item);
  S.advice.unshift(item);
  if (S.advice.length > 60) S.advice.pop();
  if (OPT.log) fs.appendFileSync(OPT.log, JSON.stringify(item) + '\n');
  if (!OPT.quiet) printAdvice(item);
  broadcast(item);
  askSolver(item);
}

/* ------------------------------------------------------------------ */
/* GTO solver（异步，慢于启发式引擎，结果后补）                          */
/* ------------------------------------------------------------------ */
let solverBusy = false;
let solverQueued = null;

function askSolver(item) {
  if (!OPT.solver || !isCurrent(item)) return;
  if (solverBusy) { solverQueued = item; return; }
  solverBusy = true;
  const body = JSON.stringify({ ...item, pot: item.potBB, toCall: item.toCallBB,
    heroStack: item.stackBB, timeBudgetMs: Math.min(3100, OPT.solverBudget || 2900),
    deadlineEpochMs: Date.parse(item.at) + 3400 });
  let finished = false;
  const done = () => {
    if (finished) return; finished = true;
    if (activeSolverReq === req) { activeSolverReq = null; activeSolverItem = null; }
    solverBusy = false;
    const q = solverQueued; solverQueued = null;
    if (q && isCurrent(q)) askSolver(q);
  };
  const req = http.request({ host: '127.0.0.1', port: OPT.solver, path: '/solve', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let buf = '';
    res.setEncoding('utf8'); res.on('data', c => { buf += c; });
    res.on('end', () => {
      try {
        if (!isCurrent(item)) { S.stats.staleDropped = (S.stats.staleDropped || 0) + 1; return; }
        const d = JSON.parse(buf);
        Object.assign(d, { kind: 'gto', decisionId: item.decisionId, hand: item.hand,
          handId: item.handId, heroCards: item.heroCards, board: item.board,
          receivedAt:new Date().toISOString(),
          endToEndMs: Date.now()-Date.parse(item.at) });
        S.gto = d;
        item.analysis = d;
        ledger.analysis(d);
        if (!d.ok) S.stats.errors++;
        else S.stats.gto = (S.stats.gto || 0) + 1;
        if (OPT.log) fs.appendFileSync(OPT.log, JSON.stringify(d) + '\n');
        broadcastGto(d);
        if (d.ok) printGto(d);
      } catch (e) { note('solver', '响应解析失败：' + e.message); }
      finally { done(); }
    });
    res.on('error', done);
  });
  req.on('error', e => {
    if (isCurrent(item)) {
      S.gto = { ok: false, decisionId: item.decisionId, error: '分析服务不可用：' + e.code };
      broadcastGto(S.gto);
    }
    done();
  });
  activeSolverReq = req; activeSolverItem = item;
  req.setTimeout(3800, () => req.destroy(new Error('solver timeout')));
  req.end(body);
}

function fmtFreq(f) { return Math.round((f || 0) * 100); }

function printGto(g) {
  if (OPT.quiet) return;
  console.log('[分析] #' + g.hand + ' ' + g.street + ' ' + g.model +
    ' 权益 ' + (g.heroEquity * 100).toFixed(1) + '% · ' + Math.round(g.totalMs) + 'ms');
}

function printAdvice(a) {
  const size = a.sizing
    ? (a.sizing.unit === 'bb'
      ? `加到 ${fmt(a.sizing.absolute * a.bbChips)}（${fmt(a.sizing.absolute, 1)}bb）`
      : `${Math.round(a.sizing.fraction * 100)}% 池 = ${fmt(a.sizing.fraction * a.potChips)}`)
    : '';
  const color = { fold: C.green, check: C.gray, call: C.blue, bet: C.red, raise: C.red, '3bet': C.red, '4bet': C.red, allin: C.red }[a.action] || C.bold;
  const board = a.board.length ? a.board.map(pretty).join(' ') : '—';
  const flags = a.flags.length ? ` ${C.yellow}[${a.flags.join(' ')}]${C.reset}` : '';
  console.log('');
  console.log(`${C.dim}──────────────────────────────────────────────────────────${C.reset}`);
  console.log(`${C.dim}#${a.hand} ${a.street} · ${a.heroPos} · ${a.heroCards.map(pretty).join(' ')} · 牌面 ${board}${C.reset}${flags}`);
  console.log(`${C.dim}底池 ${fmt(a.potBB, 1)}bb（${fmt(a.potChips)}）· 需跟 ${fmt(a.toCallBB, 1)}bb · ${a.numPlayers} 人${C.reset}`);
  console.log(`${C.bold}${color}${a.actionCN}${C.reset} ${size} ${C.dim}· 频率 ${(a.frequency * 100).toFixed(0)}% · ${a.confidence} · ${a.inMs}ms${C.reset}`);
  if (a.metrics.equity != null || a.metrics.potOdds != null) {
    const m = [];
    if (a.metrics.equity != null) m.push(`权益 ${(a.metrics.equity * 100).toFixed(1)}%`);
    if (a.metrics.potOdds != null) m.push(`需要 ${(a.metrics.potOdds * 100).toFixed(1)}%`);
    if (a.metrics.mdf != null) m.push(`MDF ${(a.metrics.mdf * 100).toFixed(0)}%`);
    if (a.metrics.spr != null) m.push(`SPR ${a.metrics.spr.toFixed(1)}`);
    console.log(`${C.dim}${m.join(' · ')}${C.reset}`);
  }
  a.reasons.slice(0, 4).forEach(r => console.log(`  ${C.dim}·${C.reset} ${r}`));
  if (a.reasons.length > 4) console.log(`  ${C.dim}…另 ${a.reasons.length - 4} 条（面板可见）${C.reset}`);
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */
const SSE = [];

function pushSSE(obj) {
  const payload = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (let i = SSE.length - 1; i >= 0; i--) {
    try { SSE[i].write(payload); } catch (e) { SSE.splice(i, 1); }
  }
}

function broadcast(item) {
  pushSSE({ item, stats: S.stats, heroSeat: S.heroSeat });
}

function broadcastGto(g) {
  pushSSE({ gto: g });
}

const PAGE = fs.readFileSync(path.join(__dirname, 'pokerist-panel.html'), 'utf8');

function recordFeedback(body) {
  if (!body || !['reasonable','questionable','unreasonable'].includes(body.rating) ||
      typeof body.decisionId!=='string' || typeof (body.comment||'')!=='string' || (body.comment||'').length>1000)
    throw new Error('反馈格式不正确');
  const item=S.advice.find(a=>a.decisionId===body.decisionId);
  if(!item || !item.analysis) throw new Error('该决策已不在当前记录中，请刷新后选择最近决策');
  const file=OPT.feedback || (OPT.log && path.join(path.dirname(OPT.log),'user-feedback.jsonl'));
  if(!file) throw new Error('反馈文件尚未配置');
  const {analysis,...request}=item;
  const row={kind:'user_feedback',at:new Date().toISOString(),version:'20261029-practical-test-v1',
    decisionId:item.decisionId,handId:item.handId,rating:body.rating,comment:body.comment||'',request,analysis};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.appendFileSync(file,JSON.stringify(row)+'\n');
  return {ok:true,decisionId:item.decisionId,rating:body.rating};
}

function startServer() {
  if (!OPT.port) return;
  const srv = http.createServer((req, res) => {
    if(req.url==='/feedback' && req.method==='POST') {
      if(req.headers.origin && req.headers.origin!=='http://'+req.headers.host){res.writeHead(403);res.end();return;}
      let body='';
      req.setEncoding('utf8');
      req.on('data',chunk=>{body+=chunk;if(body.length>8192)req.destroy();});
      req.on('end',()=>{
        try {const result=recordFeedback(JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(result));}
        catch(e){res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({ok:false,error:e.message}));}
      });
    } else if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      if (S.advice[0] && isCurrent(S.advice[0])) res.write('data: ' + JSON.stringify({ item: S.advice[0], stats: S.stats, heroSeat: S.heroSeat }) + '\n\n');
      if (S.gto) res.write('data: ' + JSON.stringify({gto: S.gto}) + '\n\n');
      SSE.push(res);
      req.on('close', () => { const i = SSE.indexOf(res); if (i >= 0) SSE.splice(i, 1); });
    } else if (req.url === '/training') {
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
      let status = {status:'not_started'};
      if (OPT.trainingStatus && fs.existsSync(OPT.trainingStatus)) {
        try { status = JSON.parse(fs.readFileSync(OPT.trainingStatus,'utf8').replace(/^\uFEFF/,'')); } catch(e) {}
      }
      if (!['disabled','stopped'].includes(status.status) && status.updatedAt && Date.now()/1000-status.updatedAt>30)
        status.status='stale';
      res.end(JSON.stringify(status));
    } else if (req.url === '/observations') {
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8'});
      const out=ledger.summary();
      out.lastObservedAt=S.lastObservedAt;
      if(OPT.reviewStatus && fs.existsSync(OPT.reviewStatus)) {
        try {out.review=JSON.parse(fs.readFileSync(OPT.reviewStatus,'utf8').replace(/^\uFEFF/,''));} catch(e) {}
      }
      if(out.review && out.review.updatedAt && Date.now()/1000-out.review.updatedAt>30) out.review.status='stale';
      res.end(JSON.stringify(out));
    } else if (req.url === '/profiles') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(Object.keys(profiles.db.players).map(id => profiles.summary(id))));
    } else if (req.url === '/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ stats: S.stats, heroSeat: S.heroSeat, table: S.table, hand: S.hand, decision: S.currentDecision, latest: S.advice[0], analysis: S.gto, profilesFile: profiles.file, observationTotals:ledger.totals, inputFile:S.inputFile, version: '20261029-practical-test-v1' }, null, 2));
    } else { res.writeHead(404); res.end('404'); }
  });
  srv.on('error', e => note('error', '面板端口不可用: ' + e.message));
  srv.listen(OPT.port, '127.0.0.1', () => note('ui', `实时面板 http://127.0.0.1:${OPT.port}`));
  return srv;
}

/* ------------------------------------------------------------------ */
/* 文件跟随                                                            */
/* ------------------------------------------------------------------ */
function follow(startFile) {
  let file = startFile;
  S.inputFile=file;
  let pos = (OPT.fromStart || OPT.warmStart) ? 0 : (fs.existsSync(file) ? fs.statSync(file).size : 0);
  let pending = Buffer.alloc(0);
  let warnedMissing = false;
  let lastChange = Date.now();

  // 采集器重启会新建一个 jsonl；文件 30s 不动就去找同目录更新的那个
  const maybeSwitch = () => {
    if (Date.now() - lastChange < 30000) return;
    const dir = path.dirname(file);
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const m = fs.statSync(full).mtimeMs;
        if (full !== file && (!best || m > best.m)) best = { full, m };
      }
    } catch (e) { return; }
    if (best && best.m > fs.statSync(file).mtimeMs) {
      note('tail', '检测到新的采集文件，切换：' + path.basename(best.full));
      file = best.full;
      S.inputFile=file;
      pos = 0;
      pending = Buffer.alloc(0);
      resetHand(); profiles.hand = null; S.snapshot = null;
      lastChange = Date.now();
    }
  };

  const tick = () => {
    maybeSwitch();
    let st;
    try { st = fs.statSync(file); } catch (e) {
      if (!warnedMissing) { note('wait', '等待文件：' + file); warnedMissing = true; }
      return;
    }
    warnedMissing = false;
    if (st.size !== pos) lastChange = Date.now();
    if (st.size < pos) {
      pos = 0; pending = Buffer.alloc(0);
      resetHand(); profiles.hand = null; S.snapshot = null;
      note('tail', '文件被重建，从头读');
    }
    if (st.size === pos) return;

    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(st.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = st.size;

    pending = Buffer.concat([pending, buf]);
    if (OPT.pace > 0) { drain(); return; }
    let idx;
    while ((idx = pending.indexOf(10)) >= 0) {
      const line = pending.slice(0, idx).toString('utf8').trim();
      pending = pending.slice(idx + 1);
      if (line) ingest(line);
    }
  };

  let paceNext = 0;
  function drain() {
    if (Date.now() < paceNext) return;
    const idx = pending.indexOf(10);
    if (idx < 0) return;
    const line = pending.slice(0, idx).toString('utf8').trim();
    pending = pending.slice(idx + 1);
    if (line) { S.lastIngestAt = Date.now(); ingest(line); }
    paceNext = Date.now() + OPT.pace;
  }

  S.warming = OPT.warmStart;
  tick();
  S.warming = false;
  if (OPT.warmStart) maybeAdvise();
  if (OPT.pace > 0) setInterval(drain, 20);
  return setInterval(tick, 100);
}

function ingest(line) {
  let rec;
  try { rec = JSON.parse(line); } catch (e) { return; }
  if(rec.observed_at) S.lastObservedAt=rec.observed_at;
  if (!S.hand) resetHand();
  if (rec.kind === 'event_received') onEvent(rec);
  else if (rec.kind === 'snapshot') onSnapshot(rec);
  else if (rec.kind === 'table_info') onTableInfo(rec);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
if (require.main === module) {
if (OPT.log) fs.mkdirSync(path.dirname(path.resolve(OPT.log)), {recursive: true});
note('start', `监听 ${OPT.file}`);
if (OPT.heroSeat != null) note('hero-seat', `手动指定座位 ${OPT.heroSeat}`);
else note('hero-seat', '未指定座位，等待首次 Private 事件自动识别');
note('config', `保留真实筹码 · 稳定等待 ${OPT.settle}ms`);
startServer();
follow(OPT.file);
if (!OPT.replay) setInterval(() => {
  const at = S.snapshot && Date.parse(S.snapshot.observed_at);
  if (S.currentDecision && at && Date.now() - at > 15000) invalidate('采集快照已超过 15 秒');
}, 1000);

if (OPT.replay) {
  const t0 = Date.now();
  const check = setInterval(() => {
    const idle = S.lastIngestAt ? Date.now() - S.lastIngestAt > 2500 : Date.now() - t0 > 2500;
    if (idle && !solverBusy && !solverQueued) {
      clearInterval(check);
      note('done', `回放完成：记录 ${S.stats.records} · 快照 ${S.stats.snapshots} · 决策 ${S.stats.decisions} · 错误 ${S.stats.errors} · GTO ${S.stats.gto || 0}`);
      process.exit(0);
    }
  }, 500);
}

}
module.exports = { OPT, S, profiles, ledger, seatPositions, ingest, flushPending, PAGE, isCurrent, askSolver, departedWagers, recordFeedback, startServer };
