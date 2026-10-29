'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {HandLedger,compareAction}=require('./hand-ledger');
const event=(t,data)=>({kind:'event_received',event_type:t,observed_at:'2026-10-27T10:00:05Z',data});
const fresh=(id='h')=>event('NewHandEventArgs',{Id:id,TableID:'t',State:{Players:[1,2,3].map(i=>
  ({m_ID:String(i),Place:i,DAmount:100,IsPlaying:true,IsSitout:false}))}});
const act=(id,who,type,amount,total=amount)=>event(type,{Id:id,TableID:'t',Who:who,Player:{m_ID:String(who)},
  LastBet:amount,TotalBetAmount:total,MoneyLeft:100-amount,Timestamp:{utc:'2026-10-27T10:00:05Z'}});
const request={decisionId:'d',handId:'t:h',heroId:'1',street:'preflop',at:'2026-10-27T10:00:00Z',bbChips:10};
const analysis={ok:true,decisionId:'d',endToEndMs:100,frequencies:{fold:.6,call:.4},
  evs:{fold:0,call:1},actionAmounts:{call:{additionalBB:1}}};
assert.equal(compareAction(request,{...analysis,recommendationReady:false},{action:'call',amount:10}).status,'unvalidated_strategy');
assert.equal(compareAction(request,{...analysis,recommendationReady:false},{action:'call',amount:10}).estimatedGapBB,null);
const winner=(id,bet,won,rake=0)=>({Player:{m_ID:String(id),Place:id},TotalBet:bet,MoneyWon:won,RakeAmount:rake});
const loser=(id,bet)=>({Player:{m_ID:String(id),Place:id},TotalBet:bet});
const result=(id='g',w=[winner(1,10,29,1)],l=[loser(2,10),loser(3,10)],pot=30)=>event('GameResultEventArgs',
  {TableID:'t',Id:id,HandID:id,Winners:w,Losers:l,Pots:[{Amount:pot}]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'poker-ledger-'));
const file=path.join(dir,'observations.jsonl');
const L=new HandLedger(file); L.event(fresh(),'1');L.snapshot({state:{DeskID:'t',StakeConfig:{BigBlind:10}}},'1');
L.decision(request);L.analysis(analysis);
const a=act('a',1,'CallEventArgs',10);L.event(a,'1');L.event(a,'1');
L.event(act('b',2,'CallEventArgs',10),'1');L.event(act('c',3,'CallEventArgs',10),'1');
L.event(result(),'1');L.event(result(),'1');
assert.equal(L.actions.length,1);assert.equal(L.actions[0].comparison.status,'in_mixed_strategy');
assert.equal(L.actions[0].comparison.differsFromTop,true,'non-top action may still be in mix');
assert.equal(L.results[0].hero.netChips,19,'do not subtract rake twice');
assert.equal(L.results[0].accountingVerified,true);assert.equal(L.results[0].historyVerified,true);
assert.equal(L.totals.heroNetBB,1.9);
const loaded=new HandLedger(file);assert.deepEqual(loaded.totals,L.totals);
loaded.event(fresh(),'1');loaded.event(result(),'1');assert.equal(loaded.totals.settledHands,1,'restart dedup');
const X=new HandLedger(null);X.event(fresh(),'1');X.decision(request);X.analysis({...analysis,endToEndMs:9000});
X.event(a,'1');assert.equal(X.actions[0].comparison.status,'no_ready_analysis','never claim late advice was available');
X.event(fresh('next'),'1');assert.equal(X.actions.length,1,'incomplete hand not fabricated as loss');
X.decision({...request,handId:'t:next',decisionId:'x'});X.event(act('other',2,'CheckEventArgs',0),'1');
X.event(a,'1');assert.equal(X.actions.length,1,'opponent action invalidates old association');
X.event(result('bad',[winner(1,10,100)],[loser(2,10)],20),'1');
assert.equal(X.results[0].accountingVerified,false);assert.equal(X.totals.heroNetChips,0);
const S=new HandLedger(null);S.event(fresh(),'1');S.event(act('1',1,'BetEventArgs',10),'1');
S.event(act('2',2,'CallEventArgs',10),'1');S.event(act('3',3,'CallEventArgs',10),'1');
S.event(result('split',[winner(1,10,14.5,.5),winner(2,10,14.5,.5)],[loser(3,10)]),'1');
assert.equal(S.results[0].accountingVerified,true);assert.equal(S.results[0].hero.netChips,4.5);
const U=new HandLedger(null);U.event(fresh(),'1');U.event(act('u1',1,'BetEventArgs',100),'1');
U.event(act('u2',2,'CallEventArgs',40),'1');U.event(result('uncalled',[winner(1,100,140)],[loser(2,40)],140),'1');
assert.equal(U.results[0].hero.netChips,40,'uncalled return included in settlement payout');
assert.equal(U.results[0].accountingVerified,true);
assert.equal(compareAction(request,analysis,{action:'raise',amount:27}).status,'off_menu');
assert.equal(compareAction(request,{...analysis,actionAmounts:{allin:{additionalBB:2.7}},frequencies:{allin:1}},
  {action:'raise',amount:27}).matchedAction,'allin');
async function ui() {
  process.argv.push('--replay','--quiet');
  const B=require('./pokerist-bridge'),vm=require('vm');
  const elements={},el=id=>elements[id]||(elements[id]={innerHTML:'',textContent:''});
  const context={document:{getElementById:el},EventSource:class{},console,setInterval(){},
    fetch:async url=>({json:async()=>url==='/observations' ? L.summary() : {status:'training'}})};
  vm.runInNewContext(B.PAGE.match(/<script>([\s\S]*?)<\/script>/)[1],context);
  await new Promise(resolve=>setImmediate(resolve));
  assert(el('observations').innerHTML.includes('1.90 bb'));
  assert(el('observations').innerHTML.includes('在混合策略内'));
}
ui().then(()=>console.log('PASS: actual decisions, mixed frequencies, timing, persistence, settlement, refunds and observation UI'))
  .catch(e=>{console.error(e);process.exitCode=1;});
