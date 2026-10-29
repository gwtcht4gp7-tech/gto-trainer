'use strict';
const fs = require('fs');
const path = require('path');
const ACTIONS = {FoldEventArgs:'fold', CheckEventArgs:'check', CallEventArgs:'call',
  BetEventArgs:'bet', RaiseEventArgs:'raise', SmallBlindEventArgs:'blind',
  BigBlindEventArgs:'blind', AnteEventArgs:'ante'};
const money = x => x == null || x === '' || !Number.isFinite(Number(x)) || Number(x) < 0 ? null : Number(x);
const close = (a,b) => Math.abs(a-b) <= 1e-5;

function compareAction(request, analysis, actual) {
  const amounts = analysis && analysis.actionAmounts || {};
  const bb = request.bbChips;
  let matched = ['fold','check','call'].includes(actual.action) ? actual.action : null;
  if (!matched && bb > 0) {
    matched = Object.keys(amounts).find(k => !['fold','check','call'].includes(k) &&
      Math.abs(amounts[k].additionalBB - actual.amount / bb) <= Math.max(.005, 1/bb)) || null;
  }
  const frequencies = analysis && analysis.frequencies || {};
  const top = Object.keys(frequencies).reduce((best,k) => best == null || frequencies[k] > frequencies[best] ? k : best, null);
  const evs = analysis && analysis.evs || {};
  const best = Object.keys(evs).length ? Math.max(...Object.values(evs)) : null;
  if(analysis && analysis.ok && analysis.model==='practical_heuristic_v1' && analysis.recommendationReady) {
    const same=matched===analysis.recommendation;
    return {matchedAction:matched,recommendedAction:analysis.recommendation,
      differsFromSuggestion:!same,status:same?'followed_test_suggestion':'different_test_action',
      estimatedGapBB:null,note:'仅记录是否与测试版建议一致，不将自选行动或单手输赢判为错误。'};
  }
  return {matchedAction:matched, topFrequencyAction:top, frequency:matched ? frequencies[matched] ?? null : null,
    differsFromTop:top && matched ? matched !== top : null,
    status:!analysis || !analysis.ok ? 'no_ready_analysis' : analysis.recommendationReady===false ? 'unvalidated_strategy' : !Object.keys(frequencies).length ? 'no_strategy_available' : !matched ? 'off_menu' :
      (frequencies[matched] || 0) > 0 ? 'in_mixed_strategy' : 'not_in_reported_mix',
    estimatedGapBB:analysis && analysis.recommendationReady!==false && matched && Number.isFinite(evs[matched]) && best != null ? best-evs[matched] : null,
    note:'混合策略中非最高频动作不等于错误；EV 差是模型估计，单手输赢不用于判定行动正确性。'};
}

// Append-only observations. Simulation training never treats real wins as labels.
class HandLedger {
  constructor(file) {
    this.file=file; this.hand=null; this.active=null; this.results=[]; this.actions=[];
    this.seenResults=new Set(); this.seenDecisions=new Set();
    this.totals={settledHands:0, verifiedHeroHands:0, verifiedHeroBBHands:0, excludedHeroHands:0, heroNetChips:0, heroNetBB:0, comparedActions:0};
    if (file && fs.existsSync(file)) for (const line of fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split('\n')) {
      try {this.remember(JSON.parse(line));} catch(e) {if (!(e instanceof SyntaxError)) throw e;}
    }
  }
  remember(row) {
    if (row.kind === 'hand_result' && !this.seenResults.has(row.resultKey)) {
      this.seenResults.add(row.resultKey); this.results.unshift(row); this.results.length=Math.min(this.results.length,30);
      this.totals.settledHands++;
      if (row.hero) {
        if (row.accountingVerified && row.hero.netChips != null) {
          this.totals.verifiedHeroHands++; this.totals.heroNetChips+=row.hero.netChips;
          if(row.hero.netBB!=null) {this.totals.heroNetBB+=row.hero.netBB;this.totals.verifiedHeroBBHands++;}
        } else this.totals.excludedHeroHands++;
      }
    }
    if (row.kind === 'decision_action' && !this.seenDecisions.has(row.decisionId)) {
      this.seenDecisions.add(row.decisionId); this.actions.unshift(row); this.actions.length=Math.min(this.actions.length,30);
      this.totals.comparedActions++;
    }
  }
  append(row) {
    if (row.kind==='hand_result' && this.seenResults.has(row.resultKey) ||
        row.kind==='decision_action' && this.seenDecisions.has(row.decisionId)) return;
    if (this.file) {fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.appendFileSync(this.file,JSON.stringify(row)+'\n');}
    this.remember(row);
  }
  decision(request) {
    if (!this.hand || this.hand.finished || request.handId!==this.hand.key) return;
    this.active={request:JSON.parse(JSON.stringify(request)),analysis:null};
  }
  analysis(result) {
    if (this.active && this.active.request.decisionId===result.decisionId)
      this.active.analysis=JSON.parse(JSON.stringify(result));
  }
  invalidate() {this.active=null;}
  snapshot(rec, heroId) {
    if (!this.hand) return;
    const st=rec.state || {};
    if (st.DeskID != null && String(st.DeskID)!==this.hand.table) return;
    if (heroId) this.hand.heroId=String(heroId);
    const bb=money((st.StakeConfig || {}).BigBlind);
    if (bb>0) this.hand.bb=bb;
  }
  event(rec, heroId) {
    const t=rec.event_type, d=rec.data || {};
    if(t==='NewHandEventArgs') {
      const st=d.State || {}, table=String(d.TableID || st.DeskID);
      const key=table+':'+String(d.Id || (d.Timestamp || {}).utc || rec.observed_at);
      if (this.hand && this.hand.key===key) return;
      if (this.hand && !this.hand.finished && this.hand.actions.length)
        this.append({kind:'hand_incomplete',handId:this.hand.key,at:rec.observed_at,reason:'未观察到结算，净盈亏未知'});
      this.active=null;
      const previousBB=this.hand && this.hand.table===table ? this.hand.bb : null;
      this.hand={key,table,street:'preflop',heroId:heroId && String(heroId),bb:previousBB,
        members:{},actions:[],seen:new Set(),complete:true};
      for(const p of st.Players || []) if(p.IsPlaying && !p.IsSitout && p.m_ID != null)
        this.hand.members[String(p.m_ID)]={id:String(p.m_ID),seat:p.Place,startStack:money(p.DAmount),invested:0};
      return;
    }
    const h=this.hand;
    if(!h || h.finished || d.TableID != null && String(d.TableID)!==h.table) return;
    if(heroId) h.heroId=String(heroId);
    const eventKey=d.Id==null ? null : t+':'+d.Id;
    if(eventKey && h.seen.has(eventKey)) return;
    if(eventKey) h.seen.add(eventKey);
    if(t==='PokerStageEventArgs') {h.street=['flop','turn','river'][(d.Stage || {}).value] || h.street;this.active=null;}
    const action=ACTIONS[t];
    if(action) {
      const p=d.Player || {}, member=Object.values(h.members).find(x=>x.seat===d.Who);
      const id=p.m_ID == null ? member && member.id : String(p.m_ID);
      if(!id) {h.complete=false;this.active=null;return;}
      const m=h.members[id] || (h.members[id]={id,seat:d.Who,startStack:null,invested:0});
      const amount=['fold','check'].includes(action) ? 0 : money(d.LastBet);
      if(amount==null) h.complete=false; else m.invested+=amount;
      const actual={eventId:eventKey,playerId:id,seat:d.Who,street:h.street,action,
        amount,total:money(d.TotalBetAmount),moneyLeft:money(d.MoneyLeft),at:(d.Timestamp || {}).utc || rec.observed_at};
      actual.observedAt=rec.observed_at;
      if(this.active && !['blind','ante'].includes(action)) {
        const a=this.active, request=a.request;
        if(id===String(request.heroId) && request.handId===h.key && request.street===h.street) {
          const readyAt=a.analysis && (a.analysis.receivedAt ? Date.parse(a.analysis.receivedAt) :
            Number.isFinite(a.analysis.endToEndMs) ? Date.parse(request.at)+a.analysis.endToEndMs : null);
          const analysis=readyAt && Date.parse(actual.observedAt || actual.at)>=readyAt ? a.analysis : null;
          this.append({kind:'decision_action',decisionId:request.decisionId,handId:h.key,at:actual.at,
            request,analysis,actual,analysisReadyBeforeActionEvent:!!analysis,comparison:compareAction(request,analysis,actual)});
        }
        this.active=null;
      }
      h.actions.push(actual);
    }
    if(t==='GameResultEventArgs') {this.settle(rec);h.finished=true;this.active=null;}
    if(t==='GameEndedEventArgs') this.active=null;
  }
  settle(rec) {
    const h=this.hand, d=rec.data, issues=[], players=new Map(), winners=d.Winners || [], losers=d.Losers || [];
    const resultKey=h.table+':'+String(d.HandID || d.Id);
    if(d.HandID==null && d.Id==null) issues.push('结算缺少稳定 ID');
    const add=(x,won) => {
      const id=x.Player && x.Player.m_ID != null ? String(x.Player.m_ID) : null;
      if(!id || players.has(id)) {issues.push('结算玩家缺失或重复');return;}
      const invested=money(x.TotalBet), received=won ? money(x.MoneyWon) : 0, rake=won ? money(x.RakeAmount) : 0;
      if(invested==null || received==null || rake==null) issues.push('结算金额缺失或非法');
      const observed=h.members[id];
      const net=invested!=null && received!=null ? received-invested : null;
      players.set(id,{id,seat:x.Player.Place,investedChips:invested,receivedChips:received,rakeChips:rake,
        observedInvestedChips:observed ? observed.invested : null,
        historyMatches:observed && invested!=null ? close(observed.invested,invested) : false,
        netChips:net,netBB:net!=null && h.bb>0 ? net/h.bb : null});
    };
    winners.forEach(x=>add(x,true));losers.forEach(x=>add(x,false));
    if(!winners.length) issues.push('结算缺少赢家');
    for(const m of Object.values(h.members)) if(!players.has(m.id)) {
      if(m.invested>0) issues.push('已投入玩家未出现在结算');
      players.set(m.id,{id:m.id,seat:m.seat,investedChips:m.invested,
        receivedChips:m.invested===0 ? 0 : null,netChips:m.invested===0 ? 0 : null,
        netBB:m.invested===0 && h.bb>0 ? 0 : null,rakeChips:0,observedInvestedChips:m.invested,historyMatches:m.invested===0});
    }
    const rows=[...players.values()];
    const invested=rows.reduce((n,p)=>n+(p.investedChips || 0),0);
    const received=rows.reduce((n,p)=>n+(p.receivedChips || 0),0);
    const rake=rows.reduce((n,p)=>n+(p.rakeChips || 0),0);
    if(!close(invested,received+rake)) issues.push('投入不等于派彩加抽水');
    const pots=d.Pots;
    if(!Array.isArray(pots) || !pots.length || pots.some(p=>money(p.Amount)==null)) issues.push('缺少有效底池结算');
    else if(!close(pots.reduce((n,p)=>n+Number(p.Amount),0),invested)) issues.push('底池金额与总投入不一致');
    const accountingVerified=issues.length===0;
    const hero=players.get(h.heroId) || null;
    this.append({kind:'hand_result',resultKey,handId:h.key,gameHandId:d.HandID || null,tableId:h.table,
      at:(d.Timestamp || {}).utc || rec.observed_at,heroId:h.heroId,bbChips:h.bb,players:rows,hero,
      investedChips:invested,receivedChips:received,rakeChips:rake,accountingVerified,
      historyVerified:h.complete && rows.every(p=>p.historyMatches),issues,
      decisions:this.actions.filter(a=>a.handId===h.key).map(a=>a.decisionId),
      note:'净盈亏=结算派彩-总投入；派彩已扣抽水，不重复扣除。未跟足退回须由结算守恒核对。'});
  }
  summary() {
    return {totals:this.totals,recentHands:this.results,recentActions:this.actions,
      file:this.file,learning:'真实结算用于审计和评测，不把单手输赢直接作为策略正确性标签。'};
  }
}
module.exports={HandLedger,compareAction};
