'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'pokerist-panel.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
let stream;const elements={},el=id=>elements[id]||(elements[id]={innerHTML:'',textContent:'',style:{}});
const timers=[];const context={document:{getElementById:el},EventSource:class{constructor(){stream=this;}},console,
  setInterval(fn){timers.push(fn);}};
vm.runInNewContext(source,context);
const send=x=>stream.onmessage({data:JSON.stringify(x)});
const a={decisionId:'d',at:new Date().toISOString(),heroId:'h',heroPos:'CO',street:'flop',bbChips:100,
  potChips:2400,toCallChips:400,toCallBB:4,numPlayers:3,heroCards:['Ah','Qs'],board:['Js','8h','2h'],
  history:[{playerId:'v',street:'preflop',action:'call',amount:100,total:100},
    {playerId:'v',street:'flop',action:'check',amount:0,total:0},
    {playerId:'v',street:'flop',action:'raise',amount:1200,total:1200}],
  opponents:[{id:'v',name:'<img src=x onerror=alert(1)>',pos:'BTN',profile:{hands:50}}]};
const g={ok:true,decisionId:'d',model:'multiplayer_fullstreet_mccfr_approx',
  recommendationReady:true,recommendation:'raise100',
  frequencies:{fold:.1,call:.7,raise100:.2},evs:{fold:0,call:.5,raise100:2},
  evStandardErrors:{fold:0,call:.1,raise100:.1},actionAmounts:{call:{additionalBB:4,raiseToBB:6},raise100:{additionalBB:18,raiseToBB:20}},
  iterations:1000,rootLocalVisits:100,rootBlueprintVisits:12,warmStartInfoSets:50,evSamplesPerAction:256,totalMs:2900,approx:['近似估计']};
send({item:a});send({gto:g});
assert(el('main').innerHTML.includes('action-raise'),'EV candidate is prominent, not the most frequent action');
assert(el('main').innerHTML.includes('2,000'),'raise-to amount must include existing wager');
assert(el('main').innerHTML.includes('本次增加 1,800'),'additional amount remains distinct');
assert(el('main').innerHTML.includes('混合策略最高频'),'disclose EV versus mixture disagreement');
assert(el('gto').innerHTML.indexOf('加注满池')<el('gto').innerHTML.indexOf('跟注'),'candidate appears before alternatives');
assert(el('routes').innerHTML.includes('翻前')&&el('routes').innerHTML.includes('翻牌'));
assert(el('routes').innerHTML.includes('加至 1,200'));
assert(!el('routes').innerHTML.includes('<img'),'opponent names must be escaped');
assert(el('routes').innerHTML.includes('&lt;img'));
send({gto:{...g,recommendation:'check',frequencies:{check:1},evs:{check:0},actionAmounts:{}}});
assert(el('main').innerHTML.includes('action-check'));
assert(!el('main').innerHTML.includes('decision-amount'),'free check has no invented bet');
send({gto:{...g,recommendation:'allin',frequencies:{allin:1},evs:{allin:2},actionAmounts:{allin:{additionalBB:450,raiseToBB:452}},policyUnstable:true}});
assert(el('main').innerHTML.includes('action-allin'));assert(el('main').innerHTML.includes('策略未稳定'));
assert(el('main').innerHTML.includes('45,200'));
send({gto:{...g,recommendation:null,frequencies:{},evs:{},model:'multiway_equity',heroEquity:.251,potOdds:.286,fallbackReason:'缺少完整历史'}});
assert(el('main').innerHTML.includes('暂不提供行动建议'),'equity-only fallback must not fabricate a recommendation');
assert(el('main').innerHTML.includes('25.1%'));
send({gto:{...g,recommendationReady:false,recommendation:null,evDiagnosticOnly:true,
  evs:{call:52.4,allin:186.5},frequencies:{call:.75,allin:.25},quality:{reasons:['unsupported_continuations']}}});
assert(el('main').innerHTML.includes('暂不提供行动建议'),'untrained rollouts must not drive a 396bb jam');
assert(!el('main').innerHTML.includes('action-allin'));assert(el('gto').innerHTML.includes('诊断数值'));
send({gto:{...g,recommendation:'check',evs:{check:-140,bet50:-129},frequencies:{check:.907,bet50:.093}}});
assert(el('main').innerHTML.includes('action-check'),'front end obeys policy result instead of re-sorting EV');
const legacy={...g};delete legacy.recommendationReady;delete legacy.recommendation;
send({gto:legacy});assert(el('main').innerHTML.includes('暂不提供行动建议'),'old fullstreet results fail closed');
send({gto:{...g,frequencies:{raise100:1},evs:{},actionAmounts:{}}});
assert(el('gto').innerHTML.includes('当前模型未提供可核对的下注金额'));
send({gto:{...g,model:'practical_heuristic_v1',recommendation:'raise',frequencies:{},evs:{},
 actionAmounts:{raise:{additionalBB:3,raiseToBB:5}},approx:['启发式测试']}});
assert(el('main').innerHTML.includes('实用测试版'),'practical advice has an explicit test label');
assert(!el('main').innerHTML.includes('混合策略主要动作'),'do not imply a solved mixed policy');
assert(el('main').innerHTML.includes('500'),'show the exact raise-to amount');
assert(el('feedback-target').textContent.includes('d'),'feedback has an explicit decision target');
send({clear:true});const empty=el('main').innerHTML;send({gto:g});
assert.equal(el('main').innerHTML,empty,'stale results cannot restore a recommendation');
send({item:{...a,at:new Date(Date.now()-16000).toISOString()}});timers[0]();
assert(el('main').innerHTML.includes('建议已过期'));
stream.onerror();assert(el('main').innerHTML.includes('连接暂时中断'));
assert(!el('main').innerHTML.includes('action-raise'));
console.log('PASS: primary EV action, exact sizing, mixed-policy distinction, uncertainty, public routes, escaping, expiry and reconnect safety');
