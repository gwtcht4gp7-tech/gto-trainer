'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const B=require('./pokerist-bridge');
const {compareAction}=require('./hand-ledger');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'practical-feedback-'));
B.OPT.feedback=path.join(dir,'feedback.jsonl');
const analysis={ok:true,model:'practical_heuristic_v1',recommendationReady:true,recommendation:'call',
 actionAmounts:{call:{additionalBB:2,raiseToBB:2}},frequencies:{},evs:{}};
B.S.advice=[{decisionId:'test:1',handId:'hand',heroCards:['As','Kd'],bbChips:100,analysis}];
const out=B.recordFeedback({decisionId:'test:1',rating:'unreasonable',comment:'尺寸不合理'});
assert(out.ok);
const rows=fs.readFileSync(B.OPT.feedback,'utf8').trim().split('\n').map(JSON.parse);
assert.equal(rows[0].decisionId,'test:1');assert.equal(rows[0].analysis.recommendation,'call');
assert(!rows[0].request.analysis,'request and displayed analysis are stored separately');
assert.throws(()=>B.recordFeedback({decisionId:'other',rating:'reasonable'}));
assert.throws(()=>B.recordFeedback({decisionId:'test:1',rating:'anything'}));
assert.equal(fs.readFileSync(B.OPT.feedback,'utf8').trim().split('\n').length,1);
assert.equal(compareAction({bbChips:100},analysis,{action:'call',amount:200}).status,'followed_test_suggestion');
const other=compareAction({bbChips:100},analysis,{action:'fold',amount:0});
assert.equal(other.status,'different_test_action');assert.equal(other.estimatedGapBB,null);
console.log('PASS: feedback binds exact request/analysis, rejects invalid IDs, records actual divergence without invented loss');
async function httpFeedback(){
 const http=require('http');
 const free=http.createServer();await new Promise(r=>free.listen(0,'127.0.0.1',r));
 const port=free.address().port;await new Promise(r=>free.close(r));
 B.OPT.port=port;B.OPT.quiet=true;
 const srv=B.startServer();await new Promise(r=>srv.once('listening',r));
 try{
  const response=await fetch('http://127.0.0.1:'+port+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({decisionId:'test:1',rating:'questionable',comment:'HTTP反馈校验'})});
  assert(response.ok);assert((await response.json()).ok);
  const saved=fs.readFileSync(B.OPT.feedback,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(saved.length,2);assert.equal(saved[1].comment,'HTTP反馈校验');
  const denied=await fetch('http://127.0.0.1:'+port+'/feedback',{method:'POST',headers:{Origin:'https://example.invalid'},body:'{}'});
  assert.equal(denied.status,403);
 }finally{srv.closeAllConnections();await new Promise(r=>srv.close(r));}
 console.log('PASS: actual HTTP feedback save and cross-origin rejection');
}
httpFeedback().catch(e=>{console.error(e);process.exitCode=1;});
