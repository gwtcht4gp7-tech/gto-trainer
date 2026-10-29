'use strict';

const fs = require('fs');
const path = require('path');
const ACTIONS = { CallEventArgs: 'call', CheckEventArgs: 'check', FoldEventArgs: 'fold',
  BetEventArgs: 'bet', RaiseEventArgs: 'raise', SmallBlindEventArgs: 'blind',
  BigBlindEventArgs: 'blind', AnteEventArgs: 'ante' };
const STREETS = ['flop', 'turn', 'river'];

// Only public actions are stored. IDs, not seats or nicknames, identify players.
class PlayerProfiles {
  constructor(file) {
    this.file = file;
    this.db = { version: 1, players: {}, completedHands: {} };
    if (file && fs.existsSync(file)) {
      this.db = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (this.db.version !== 1) throw new Error('Unsupported player-profile version');
    }
    this.hand = null;
  }

  identify(p) {
    const id = p && p.m_ID != null ? String(p.m_ID) : null;
    if (!id || id === '0') return null;
    let x = this.db.players[id];
    if (!x) x = this.db.players[id] = { id, names: [], hands: 0, vpip: 0, pfr: 0,
      postflopAggressive: 0, postflopCalls: 0, facingBet: 0, foldToBet: 0,
      showdowns: 0, lastSeen: null };
    if (p.m_Nick && !x.names.includes(p.m_Nick)) x.names.push(p.m_Nick);
    return id;
  }

  observePlayers(players) {
    for (const p of players || []) {
      const id = this.identify(p);
      if (!id || !this.hand || !this.hand.members[p.Place]) continue;
      const m = this.hand.members[p.Place];
      if (m.id === id && Number(p.CardsCount) > 0) m.dealt = true;
      if (m.id !== id || p.Folded || p.TableAmount == null) continue;
      const h = this.hand, current = h.actions.filter(a => a.street === h.street && a.playerId === id);
      // Pokerist also calls an entry live blind "Ante". Confirm only against a
      // captured wager before any voluntary betting, never by event name alone.
      if (h.actions.some(a => a.street === h.street && !['blind','ante'].includes(a.action))) continue;
      const credited = current.reduce((n,a) => n + (a.action === 'ante' ? a.liveAmount || 0 : a.amount), 0);
      const extra = Number(p.TableAmount) - credited;
      const candidates = current.filter(a => a.action === 'ante' && a.amount > 0 && !a.liveAmount);
      const possible = candidates.reduce((n,a) => n + a.amount, 0);
      if (extra <= 0 || !Number.isFinite(extra) || Math.abs(extra-possible) > 1e-5) continue;
      for (const a of candidates) {a.liveAmount=a.amount;a.liveEvidence='captured_pre_action_wager';}
      h.wagers[p.Place]=Number(p.TableAmount);h.maxWager=Math.max(h.maxWager,h.wagers[p.Place]);
    }
  }

  event(rec, board = [], card = x => x) {
    const d = rec.data || {}, t = rec.event_type;
    if (t === 'NewHandEventArgs') {
      // A missing result is incomplete evidence; do not invent an opportunity.
      const state = d.State || {};
      this.hand = { key: String(d.TableID || state.DeskID) + ':' +
        String(d.Id || (d.Timestamp || {}).utc || rec.observed_at), street: 'preflop',
        members: {}, actions: [], seen: new Set(), wagers: {}, maxWager: 0, minRaise: 0 };
      for (const p of state.Players || []) {
        const id = this.identify(p);
        if (id && p.IsPlaying && !p.IsSitout) this.hand.members[p.Place] = {
          id, seat: p.Place, dealt: Number(p.DAmount) > 0, vpip: false, pfr: false,
          postflopAggressive: 0, postflopCalls: 0, facingBet: 0, foldToBet: 0,
          showdown: false };
      }
      return;
    }
    const h = this.hand;
    if (!h || h.finished || (d.TableID && !h.key.startsWith(String(d.TableID) + ':'))) return;
    const eventKey = d.Id == null ? null : t + ':' + d.Id;
    if (eventKey && h.seen.has(eventKey)) return;
    if (eventKey) h.seen.add(eventKey);
    if (t === 'PokerStageEventArgs') {
      h.street = STREETS[(d.Stage || {}).value] || h.street;
      h.wagers = {}; h.maxWager = 0; h.minRaise = 0;
    }
    const action = ACTIONS[t];
    if (action) {
      const id = this.identify(d.Player) || (h.members[d.Who] || {}).id;
      if (!id) return;
      let m = h.members[d.Who];
      if (!m || m.id !== id) m = h.members[d.Who] = { id, seat: d.Who, dealt: true,
        vpip: false, pfr: false, postflopAggressive: 0, postflopCalls: 0,
        facingBet: 0, foldToBet: 0, showdown: false };
      m.dealt = true;
      const facing = h.maxWager > (h.wagers[d.Who] || 0);
      if (h.street === 'preflop') {
        if (['call', 'bet', 'raise'].includes(action)) m.vpip = true;
        if (['bet', 'raise'].includes(action)) m.pfr = true;
      } else if (!['blind', 'ante'].includes(action)) {
        if (['bet', 'raise'].includes(action)) m.postflopAggressive++;
        if (action === 'call') m.postflopCalls++;
        if (facing && ['fold', 'call', 'raise'].includes(action)) {
          m.facingBet++; if (action === 'fold') m.foldToBet++;
        }
      }
      const total = Number(d.TotalBetAmount) || 0;
      const increment = Math.max(0, total - h.maxWager);
      if (['blind', 'bet', 'raise'].includes(action)) h.minRaise = Math.max(h.minRaise, increment);
      // Ante is dead money, not a live wager to be matched.
      if (!['ante', 'fold', 'check'].includes(action)) {
        h.wagers[d.Who] = total; h.maxWager = Math.max(h.maxWager, total);
      }
      h.actions.push({ id: eventKey, playerId: id, seat: d.Who, street: h.street,
        action, amount: ['fold','check'].includes(action) ? 0 : Number(d.LastBet) || 0, total, facing, minRaise: h.minRaise,
        board: board.slice(), moneyLeft: d.MoneyLeft == null ? null : Number(d.MoneyLeft),
        at: (d.Timestamp || {}).utc || rec.observed_at });
    }
    if (t === 'GameResultEventArgs') {
      const shown = [];
      for (const s of d.Showdown || []) {
        const m = h.members[s.Place];
        if (m) { m.showdown = true; shown.push({ playerId: m.id,
          cards: (s.Cards || []).map(card).filter(Boolean) }); }
      }
      h.showdown = shown;
      this.finish(rec.observed_at);
    }
  }

  finish(at) {
    const h = this.hand;
    if (!h || h.finished) return;
    h.finished = true;
    if (this.db.completedHands[h.key]) return;
    for (const m of Object.values(h.members)) {
      if (!m.dealt) continue;
      const p = this.db.players[m.id];
      p.hands++; p.vpip += Number(m.vpip); p.pfr += Number(m.pfr);
      for (const k of ['postflopAggressive', 'postflopCalls', 'facingBet', 'foldToBet']) p[k] += m[k];
      p.showdowns += Number(m.showdown); p.lastSeen = at;
    }
    this.db.completedHands[h.key] = at || true;
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.db, null, 2));
      fs.renameSync(this.file + '.tmp', this.file);
      fs.appendFileSync(this.file.replace(/\.json$/i, '') + '-hands.jsonl',
        JSON.stringify({ handId: h.key, at, actions: h.actions, showdown: h.showdown }) + '\n');
    }
  }

  summary(id) {
    const p = this.db.players[String(id)];
    if (!p) return { id: String(id), hands: 0, sampleWeight: 0, vpipRate: .3, pfrRate: .18 };
    return { ...p, sampleWeight: p.hands / (p.hands + 40),
      vpipRate: (p.vpip + 40 * .3) / (p.hands + 40),
      pfrRate: (p.pfr + 40 * .18) / (p.hands + 40),
      aggressionRate: (p.postflopAggressive + 12 * .4) /
        (p.postflopAggressive + p.postflopCalls + 12),
      foldToBetRate: (p.foldToBet + 20 * .45) / (p.facingBet + 20) };
  }
}

module.exports = { PlayerProfiles };
