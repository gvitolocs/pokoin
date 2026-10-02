'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Module=require('node:module');
const path=require('node:path');
const diagnostics=require('./_scan_diagnostics');
function handler(store,logs){
 const target=path.resolve(__dirname,'scan-phone.js');
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent?.filename===target && request==='./_scan_store')return {getScanStore:()=>store};
  if(parent?.filename===target && request==='./_scan_diagnostics')return {...diagnostics,recordDiagnostics:args=>diagnostics.recordDiagnostics({...args,log:(_,json)=>logs.push(JSON.parse(json))})};
  return original.call(this,request,parent,isMain);
 };
 try{delete require.cache[target];return require(target);}finally{Module._load=original;}
}
function response(){return {writableEnded:false,headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=value?JSON.parse(value):null;this.writableEnded=true;}};}
const packet={version:diagnostics.DIAGNOSTICS_VERSION,runId:'phone-handler-test-run',entries:[{sequence:1,kind:'gate',sessionId:'forged',token:'secret'}]};
test('phone heartbeat authenticates before logging and returns real session attribution and acknowledgment',async()=>{
 const logs=[];
 const fn=handler({heartbeat:async({token})=>{assert.equal(token,'valid-token');return {sessionId:'trusted-session',batchId:'trusted-batch',paused:false};}},logs);
 const res=response();await fn({method:'POST',url:'/api/scan-phone?action=heartbeat',headers:{authorization:'Scan valid-token'},body:{diagnostics:packet}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.diagnosticsVersion,diagnostics.DIAGNOSTICS_VERSION);assert.deepEqual(res.body.diagnosticAck,[1]);
 assert.equal(logs[0].sessionId,'trusted-session');assert.equal(logs[0].batchId,'trusted-batch');assert.ok(!JSON.stringify(logs).includes('secret'));
});
test('expired and absent phone credentials cannot write diagnostics',async()=>{
 const logs=[];
 const fn=handler({heartbeat:async()=>{throw Object.assign(new Error('Expired'),{statusCode:401});}},logs);
 for(const authorization of ['Scan expired','']){
  const res=response();await fn({method:'POST',url:'/api/scan-phone?action=heartbeat',headers:{authorization},body:{diagnostics:packet}},res);assert.equal(res.statusCode,401);
 }
 assert.deepEqual(logs,[]);
});
test('old clients still get ordinary heartbeats without diagnostic packets',async()=>{
 const logs=[],fn=handler({heartbeat:async()=>({sessionId:'old-client',paused:false,received:9})},logs);
 const res=response();await fn({method:'POST',url:'/api/scan-phone?action=heartbeat',headers:{authorization:'Scan valid'},body:{}},res);
 assert.equal(res.statusCode,200);assert.equal(res.body.received,9);assert.deepEqual(res.body.diagnosticAck,[]);assert.deepEqual(logs,[]);
});
