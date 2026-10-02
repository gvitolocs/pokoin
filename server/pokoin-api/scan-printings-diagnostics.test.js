'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const rules=require('./_scan_connect');
const {recordDiagnostics,DIAGNOSTICS_VERSION}=require('./_scan_diagnostics');
const {create}=require('../scan/web/static/scan-diagnostics');
const crispin=[
  ['596880','Stellar Crown','133/142'],['633460','Prismatic Evolutions','105/131'],
  ['636054','Prismatic Evolutions - Poké Ball Reverse Holo','Poké Ball Reverse Holo | 105/131'],
  ['643614','Play! Pokémon Prize Pack Series','Non-Holo | 133/142'],
  ['701786','Play! Pokémon Prize Pack Series','Cosmos Holo | 133/142'],
].map(([card_id,set_name,card_number])=>({card_id,name:'Crispin',set_name,card_number,version:'v589520',nationality:'western'}));
const hit=(id,score)=>({public_id:id,name:'Crispin',score});
for(const hits of [[hit('596880',.8947)], [hit('596880',.8947),hit('633460',.7)], [hit('596880',.8809),hit('633460',.8719)]]) {
  test('Crispin offers every western printing regardless of collector number and individual score '+hits.length+':'+hits.at(-1).score,()=>{
    const answer=rules.resolvePrintings({hits,rows:crispin,language:'IT'});
    assert.deepEqual(new Set(answer.printings.map(p=>p.card_id)),new Set(crispin.map(p=>p.card_id)));
    assert.equal(answer.choose,true);
    const chosen=rules.resolvePrintings({hits,rows:crispin,language:'IT',choice:'633460'});
    assert.equal(chosen.cardId,'633460');assert.equal(chosen.state,'matched');
  });
}
test('every batch language sees all same-artwork expansions and print languages',()=>{
 const extra=['japanese','korean','chinese','indonesian','thai'].map((nationality,i)=>({...crispin[0],card_id:String(900+i),nationality}));
 const rows=[...crispin,...extra];
 for(const language of ['IT','EN','JP','KO','ZH','TH']) {
  const answer=rules.resolvePrintings({hits:[hit('900',.95),hit('596880',.82)],rows,language});
  assert.equal(answer.printings.length,10);
  for(const row of rows) {
   const chosen=rules.resolvePrintings({hits:[hit('900',.95)],rows,language,choice:row.card_id});
   assert.equal(chosen.cardId,row.card_id);assert.equal(chosen.state,'matched');
  }
 }
});
test('selected foreign printing gets a compatible listing language',()=>{
 assert.equal(rules.listingLanguageForPrint('japanese','IT'),'JP');
 assert.equal(rules.listingLanguageForPrint('korean','IT'),'KO');
 assert.equal(rules.listingLanguageForPrint('chinese','IT'),'ZH');
 assert.equal(rules.listingLanguageForPrint('chinese','ZHT'),'ZHT');
 assert.equal(rules.listingLanguageForPrint('western','JP'),'EN');
 assert.equal(rules.listingLanguageForPrint('western','IT'),'IT');
 assert.equal(rules.listingLanguageForPrint('indonesian','IT'),'ID');
 assert.equal(rules.listingLanguageForPrint('thai','IT'),'TH');
});
test('uncertain artwork stays uncertain and a choice from another artwork is rejected',()=>{
 const rival={...crispin[0],card_id:'901',version:'other'};
 assert.equal(rules.resolvePrintings({hits:[hit('596880',.9),hit('901',.85)],rows:[...crispin,rival],language:'IT'}),null);
 assert.equal(rules.resolvePrintings({hits:[hit('596880',.7)],rows:crispin,language:'IT'}),null);
 const answer=rules.resolvePrintings({hits:[hit('596880',.9)],rows:[...crispin,rival],language:'IT',choice:'901'});
 assert.equal(answer.chosen,'');assert.equal(answer.state,'ambiguous');
});
test('large artwork groups are complete instead of silently suppressing the picker',()=>{
 const rows=Array.from({length:130},(_,i)=>({...crispin[0],card_id:String(i+1),card_number:String(i+1)}));
 const answer=rules.resolvePrintings({hits:[hit('1',.9)],rows,language:'EN'});
 assert.equal(answer.printings.length,130);
});
function memory(){const map=new Map();return {getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)};}
test('diagnostics survive loss, reload and partial acknowledgment, and reach the server without truncation',()=>{
 const storage=memory(),opts={storage,sessionId:'session-a',uuid:()=> '12345678-1234-1234-1234-123456789012',now:()=>123};
 let queue=create(opts);
 for(let i=0;i<40;i++)queue.record('gate',{hits:[hit('633460',.92)],gateAfter:{armed:false,emittedId:'633460'},offered:crispin.map(p=>p.card_id)});
 const first=queue.packet();assert.equal(first.entries.length,32);
 queue=create(opts);assert.equal(queue.pending,40);
 const logs=[],log=(label,json)=>logs.push([label,JSON.parse(json)]);
 const ack=recordDiagnostics({sessionId:'session-a',batchId:'batch',packet:first,log});
 assert.equal(ack.length,32);assert.equal(logs.length,32);
 assert.deepEqual(logs[0][1].offered,crispin.map(p=>p.card_id));
 assert.equal(logs[0][1].hits[0].id,'633460');
 // Lost response: resend the packet, server acknowledges without duplicate logging.
 assert.deepEqual(recordDiagnostics({sessionId:'session-a',packet:first,log}),ack);
 assert.equal(logs.length,32);
 queue.acknowledge(ack);assert.equal(queue.pending,8);
 const rest=queue.packet();assert.equal(rest.entries[0].sequence,33);
 queue.acknowledge(recordDiagnostics({sessionId:'session-a',packet:rest,log}));assert.equal(queue.pending,0);
 queue=create(opts);assert.equal(queue.pending,0);
});
test('diagnostics sanitize all fields and never record credentials, blobs or client session identity',()=>{
 const logs=[];
 const packet={version:DIAGNOSTICS_VERSION,runId:'sanitize-test-run-123',entries:[{sequence:1,kind:'gate',token:'secret',blob:'bytes',sessionId:'forged',hits:[{public_id:'633460',score:.9,phoneToken:'secret'}]}]};
 const ack=recordDiagnostics({sessionId:'trusted',packet,log:(_,json)=>logs.push(json)});
 assert.deepEqual(ack,[1]);assert.equal(logs.length,1);
 assert.ok(!/secret|bytes|forged/.test(logs[0]));
 assert.deepEqual(recordDiagnostics({packet,log:()=>assert.fail('untrusted log')}),[]);
 assert.deepEqual(recordDiagnostics({sessionId:'trusted',packet:{...packet,version:'old'},log:()=>assert.fail('old log')}),[]);
});
