'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
process.argv.push('--replay', '--quiet');
const B = require('./pokerist-bridge');
const {PlayerProfiles} = require('./player-profiles');
B.OPT.solver = 0; B.S.heroSeat = 3;
const event = (type, data) => ({kind:'event_received', event_type:type, observed_at:'2026-10-27T08:00:00Z', data});
const people = [1,3,5,7,9].map((seat,i)=>({Place:seat,m_ID:String(i+100),m_Nick:'Guest',
  IsPlaying:true,IsSitout:false,Folded:false,CardsCount:2,DAmount:10000,TableAmount:0}));
const fresh = id => event('NewHandEventArgs', {Id:id,TableID:'table',DealerPlace:9,
  State:{DeskID:'table',DealerPlace:9,SeatPlaces:[1,3,5,7,9],Players:people}});
const action = (type,seat,id,total=0) => event(type,{Id:id,TableID:'table',Who:seat,
  Player:people.find(p=>p.Place===seat),LastBet:total,TotalBetAmount:total});
const result = () => event('GameResultEventArgs',{TableID:'table',Id:'result',Showdown:[]});

const leftHistory=[{playerId:'gone',street:'preflop',action:'ante',amount:50,liveAmount:50},
  {playerId:'gone',street:'preflop',action:'fold',amount:0,total:50},
  {playerId:'here',street:'preflop',action:'call',amount:100}];
const captured={gone:{street:'preflop',amount:50}};
assert.deepEqual(B.departedWagers([{m_ID:'here'}],leftHistory,'preflop',captured,100),[{id:'gone',amount:50}]);
assert.deepEqual(B.departedWagers([{m_ID:'here'},{m_ID:'gone'}],leftHistory,'preflop',captured,150),[],'present wagers are not double counted');
assert.deepEqual(B.departedWagers([{m_ID:'here'}],leftHistory,'flop',captured,150),[],'closed street money is not restored twice');
assert.deepEqual(B.departedWagers([{m_ID:'here'}],leftHistory.filter(a=>a.action!=='fold'),'preflop',captured,100),[],'missing live player is not silently treated as folded');
assert.deepEqual(B.departedWagers([{m_ID:'here'}],leftHistory,'preflop',captured,150),[],'pot already includes money');
assert.deepEqual(B.departedWagers([{m_ID:'here'}],leftHistory,'preflop',{gone:{street:'preflop',amount:25}},100),[],'contradictory captured wager stays rejected');

assert.deepEqual(B.seatPositions([1,3],1),{1:'BTN',3:'BB'});
assert.deepEqual(B.seatPositions([1,3,5,7,9],9),{9:'BTN',1:'SB',3:'BB',5:'UTG',7:'CO'});

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'poker-profile-test-'));
const file=path.join(dir,'profiles.json');
const P=new PlayerProfiles(file);
P.event(fresh('hand1'));
P.event(action('RaiseEventArgs',1,'r1',10));
P.event(action('RaiseEventArgs',1,'r1',10)); // Duplicate event.
P.event(action('CallEventArgs',3,'c1',10));
P.event(result());P.event(result());
assert.equal(P.summary('100').hands,1);assert.equal(P.summary('100').pfr,1);
assert.equal(P.summary('101').vpip,1);assert.equal(P.summary('101').pfr,0);
const loaded=new PlayerProfiles(file);
loaded.event(fresh('hand1'));loaded.event(action('RaiseEventArgs',1,'r1',10));loaded.event(result());
assert.equal(loaded.summary('100').hands,1,'restart/replay must not count hands twice');
loaded.event(fresh('incomplete'));loaded.event(fresh('next')); // No result for first.
assert.equal(loaded.summary('100').hands,1);
assert.notEqual(loaded.summary('100').id,loaded.summary('101').id,'same nickname must not merge');

const entry=new PlayerProfiles(null);entry.event(fresh('entry'));
entry.event(action('BigBlindEventArgs',3,'bb',50));entry.event(action('AnteEventArgs',5,'entry-post',50));
entry.observePlayers(people.map(p=>({...p,TableAmount:[3,5].includes(p.Place)?50:0})));
assert.equal(entry.hand.actions.at(-1).liveAmount,50,'captured entry blind must count as a live wager');
assert.equal(entry.hand.wagers[5],50);assert.equal(entry.hand.members[5].vpip,false,'forced post is not voluntary');
const dead=new PlayerProfiles(null);dead.event(fresh('dead'));dead.event(action('AnteEventArgs',5,'dead-post',50));
dead.observePlayers(people);assert(!dead.hand.actions.at(-1).liveAmount,'genuine dead ante stays dead');
const uncertain=new PlayerProfiles(null);uncertain.event(fresh('uncertain'));
uncertain.event(action('AnteEventArgs',5,'unconfirmed-post',50));
uncertain.observePlayers(people.map(p=>({...p,TableAmount:p.Place===5?25:0})));
assert(!uncertain.hand.actions.at(-1).liveAmount,'do not patch an inconsistent snapshot');
uncertain.event(action('CallEventArgs',1,'voluntary',50));
uncertain.observePlayers(people.map(p=>({...p,TableAmount:p.Place===5?50:0})));
assert(!uncertain.hand.actions[0].liveAmount,'do not infer missing betting from a later snapshot');

const ingest=r=>B.ingest(JSON.stringify(r));
ingest(fresh('bridge1'));
ingest(action('RaiseEventArgs',1,'ar',50));
const card=c=>({Value:{value:'23456789TJQKA'.indexOf(c[0])+2},Suite:{label:{s:'SPADES',h:'HEARTS',d:'DIAMONDS',c:'CLUBS'}[c[1]]}});
const snap={kind:'snapshot',state:{DeskID:'table',GameInProgress:true,Current:3,
  DealerPlace:9,SeatPlaces:[1,3,5,7,9],Players:people,PrivateCards:['As','Kh'].map(card),Cards:[],
  StakeConfig:{BigBlind:10,Pot:100,Call:20}}};
ingest(snap);
const first=B.S.advice[0];
assert(first.decisionId);assert.equal(first.stackBB,1000,'no 300bb cap');
assert.equal(first.history.length,1);assert.equal(first.opponents.length,4);
assert.equal(first.historyComplete,true);assert.equal(first.heroPos,'BB');
assert.equal(first.heroIsOop,true);
ingest(action('FoldEventArgs',5,'fold'));
assert.equal(B.S.currentDecision,null,'action immediately invalidates old results');
assert.equal(B.isCurrent(first),false);
ingest({...snap,state:{...snap.state,Players:people.map(p=>({...p,Folded:p.Place===5}))}});
assert.equal(B.S.advice[0].opponents.find(p=>p.seat===7).pos,'CO','fold must not relabel positions');
ingest({...snap,state:{...snap.state,Current:7}});
assert.equal(B.S.currentDecision,null,'stale Call > 0 does not imply hero turn');

const elements={};const el=id=>elements[id]||(elements[id]={innerHTML:'',textContent:''});
let stream;
const context={document:{getElementById:el}, EventSource:class {constructor(){stream=this;}},console};
vm.runInNewContext(B.PAGE.match(/<script>([\s\S]*?)<\/script>/)[1],context);
const send=m=>stream.onmessage({data:JSON.stringify(m)});
send({item:first,stats:B.S.stats,heroSeat:3});
const g={ok:true,decisionId:first.decisionId,model:'multiway_equity',heroEquity:.2,standardError:.01,
 samples:800,hand:1,street:'preflop',historyActions:1,totalMs:10,approx:[]};
send({gto:g});assert(el('gto').innerHTML.includes('20.0%'));
send({gto:{...g,model:'multiplayer_fullstreet_mccfr_approx',heroEquity:undefined,
  frequencies:{fold:.2,call:.8},evs:{fold:0,call:2},evStandardErrors:{fold:0,call:1},
  iterations:100,rootLocalVisits:20,warmStartInfoSets:3,rootBlueprintVisits:10,evSamplesPerAction:64}});
assert(el('gto').innerHTML.includes('64'));
assert(!el('gto').innerHTML.includes('NaN'));
const next={...first,decisionId:'next'};send({item:next,stats:B.S.stats,heroSeat:3});
assert.equal(el('gto').textContent,'正在分析当前决策…');
const before=el('gto').innerHTML;send({gto:g});assert.equal(el('gto').innerHTML,before);
send({clear:true});assert.equal(el('gto').textContent,'上次分析已失效');
// Warm-start identity recovery must work before any advisory decision is emitted.
B.S.warming=true;
ingest(event('PlayerStakeEventArgsPrivate',{TableID:'table',Timestamp:{utc:'2026-10-27T08:00:00Z'}}));
const identity=B.S.heroId;
ingest(action('CallEventArgs',1,'unrelated'));
assert.equal(B.S.heroId,identity,'unrelated public action is not a private echo');
ingest(action('PlayerStakeEventArgs',1,'echo'));
assert.equal(B.S.heroId,'100');assert.equal(B.S.heroSeat,1);
B.S.warming=false;
async function lateResponse() {
  const http=require('http');
  const server=http.createServer((req,res)=>{
    if(req.url==='/cancel'){req.resume();res.end('{"ok":true}');return;}
    let body='';req.on('data',x=>body+=x);req.on('end',()=>{
      const sent=JSON.parse(body);
      assert.equal(sent.history.length,1);assert.equal(sent.opponents.length,4);
      ingest(fresh('newer-hand'));
      res.end(JSON.stringify({...g,decisionId:first.decisionId}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  B.OPT.solver=server.address().port;
  B.S.currentDecision=first.decisionId;
  B.askSolver(first);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(B.S.gto,null,'late HTTP response must not revive an old hand');
  assert(B.S.stats.staleDropped===1 || B.S.stats.cancelledRequests>=1);
  await new Promise(resolve=>server.close(resolve));
}
lateResponse().then(()=>console.log('PASS: persistence, dedup, history, positions, real stacks, turn guard, stale UI and delayed HTTP response'))
 .catch(e=>{console.error(e);process.exitCode=1;});
