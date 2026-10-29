'use strict';
// One-time replay into a separate observation file; never runs a solver or writes player profiles.
const fs=require('fs');
const [input,advice,output]=process.argv.slice(2);
if(!input || !output) throw new Error('usage: node backfill-ledger.js input.jsonl advice.jsonl output.jsonl');
process.argv=['node','backfill','--replay','--quiet','--observations',output];
const B=require('./pokerist-bridge');B.OPT.solver=0;B.S.warming=true;
const decisions=new Map(),analyses=new Map();
if(advice && fs.existsSync(advice)) for(const line of fs.readFileSync(advice,'utf8').split('\n')) {
  let r;try{r=JSON.parse(line);}catch(e){continue;}
  if(r.kind==='decision') {const k=r.handId+':'+r.history.length;const a=decisions.get(k)||[];a.push(r);decisions.set(k,a);}
  if(r.kind==='gto') analyses.set(r.decisionId,r);
}
for(const line of fs.readFileSync(input,'utf8').replace(/^\uFEFF/,'').split('\n')) {
  let r;try{r=JSON.parse(line);}catch(e){continue;}
  const h=B.profiles.hand;
  if(h && r.kind==='event_received' && ['FoldEventArgs','CheckEventArgs','CallEventArgs','BetEventArgs','RaiseEventArgs'].includes(r.event_type)) {
    const at=Date.parse((r.data.Timestamp||{}).utc||r.observed_at),id=r.data.Player && String(r.data.Player.m_ID);
    const candidates=decisions.get(h.key+':'+h.actions.length)||[];
    let d=candidates.filter(x=>String(x.heroId)===id && Date.parse(x.at)<=at).at(-1);
    if(d) {
      const st=B.S.snapshot && B.S.snapshot.state;
      if(!d.playersContext && st && B.S.hand.startPlayers) {
        const live=new Set([String(d.heroId),...d.opponents.map(p=>String(p.id))]);
        d={...d,fullStreet:true,dealerSeat:st.DealerPlace,contextSource:'captured_history_and_snapshot',
          playersContext:B.S.hand.startPlayers.map(p=>{
            const current=(st.Players||[]).find(x=>String(x.m_ID)===p.id);
            const opponent=d.opponents.find(x=>String(x.id)===p.id);
            return {id:p.id,seat:p.seat,pos:p.id===String(d.heroId)?d.heroPos:opponent && opponent.pos,
              stackBB:current ? Number(current.DAmount)/d.bbChips : 0,
              wagerBB:current ? Number(current.TableAmount)/d.bbChips : 0,folded:!live.has(p.id),profile:opponent && opponent.profile};
          }),history:d.history.map((x,i)=>({...x,moneyLeftBB:h.actions[i].moneyLeft==null ? null : h.actions[i].moneyLeft/d.bbChips}))};
      }
      B.ledger.decision(d);const g=analyses.get(d.decisionId);if(g) B.ledger.analysis(g);
    }
  }
  B.ingest(line);
}
console.log(JSON.stringify({totals:B.ledger.totals,output,recentAccounting:B.ledger.results.slice(0,5).map(x=>
  ({verified:x.accountingVerified,history:x.historyVerified,issues:x.issues}))},null,2));
