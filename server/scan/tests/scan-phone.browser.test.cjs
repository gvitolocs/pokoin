const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {chromium}=require(process.env.PLAYWRIGHT_CORE || '/home/nez/Projects/pokemon-card-extension/node_modules/playwright-core');
const rules=require('../../pokoin-api/_scan_connect');
const diagnostic=require('../../pokoin-api/_scan_diagnostics');
const WEB=path.resolve(__dirname,'../web');
const rows=[['596880','Stellar Crown','133/142'],['633460','Prismatic Evolutions','105/131'],['636054','Prismatic Evolutions - Poké Ball Reverse Holo','105/131'],['643614','Prize Pack non-holo','133/142'],['701786','Prize Pack cosmos','133/142']].map(([card_id,set_name,card_number])=>({card_id,set_name,card_number,name:'Crispin',version:'v589520',nationality:'western'}));
rows.push({...rows[0],card_id:'900',set_name:'Japanese Starter',card_number:'018/022',nationality:'japanese'}, {...rows[0],card_id:'901',set_name:'Chinese Expansion',card_number:'196/208',nationality:'chinese'});
const recognize={ok:true,catalog:'pokemon_generic',img_w:640,img_h:480,detect_ms:5,identify_ms:120,orientations:1,boxes:[{xyxy:[0,0,300,420],conf:.96}],hits:[{public_id:'596880',name:'Crispin',score:.91},{public_id:'633460',name:'Crispin',score:.7}]};
recognize.top1=recognize.hits[0];
test('phone captures Crispin, shows all printings, uploads the chosen Prismatic printing and delivers diagnostics after network loss/reload',async()=>{
 const errors=[],logs=[],uploads=[];let recognizing=false,dropHeartbeats=false;
 const auth=token=>{if(token!=='test-phone-token')throw Object.assign(new Error('Disconnected'),{statusCode:401});};
 const store={
  heartbeat:async({token})=>{auth(token);return {sessionId:'browser-session',batchId:'browser-batch',serverTime:Date.now(),paused:false,received:uploads.length};},
  resolvePrintingsForPhone:async({token,body})=>{auth(token);const p=rules.resolvePrintings({hits:body.recognition.hits,rows,language:'IT'});return {...p,serverTime:Date.now(),printings:p.printings.map(rules.printingTile)};},
  ingestScan:async({token,body})=>{auth(token);uploads.push(body);return {received:uploads.length};},
 };
 const target=path.resolve(__dirname,'../../pokoin-api/scan-phone.js');
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(parent?.filename===target && request==='./_scan_store')return {getScanStore:()=>store};
  if(parent?.filename===target && request==='./_scan_diagnostics')return {...diagnostic,recordDiagnostics:args=>diagnostic.recordDiagnostics({...args,log:(_,json)=>logs.push(JSON.parse(json))})};
  return original.call(this,request,parent,isMain);
 };
 let handler;try{delete require.cache[target];handler=require(target);}finally{Module._load=original;}
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/scan-phone'){
   if(dropHeartbeats && url.searchParams.get('action')==='heartbeat'){req.socket.destroy();return;}
   let body='';for await(const chunk of req)body+=chunk;
   req.body=JSON.parse(body||'{}');return handler(req,res);
  }
  if(url.pathname==='/api/scan/catalogs'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({catalogs:[{id:'pokemon_western'},{id:'pokemon_generic'}]}));return;}
  if(url.pathname==='/api/scan/identify'){
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(recognizing?recognize:{...recognize,hits:[],top1:null,boxes:[]}));return;
  }
  const file=url.pathname.startsWith('/static/')?path.join(WEB,url.pathname):path.join(WEB,'index.html');
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.png')?'image/png':'text/html');fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera']});
 await context.addInitScript(()=>{
  window.SCAN_CONNECT_API=location.origin;window.CARDSCAN_API=location.origin+'/api/scan';
  localStorage.setItem('pokoin.scanConnect.v1',JSON.stringify({token:'test-phone-token',sessionId:'browser-session'}));
 });
 try{
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/connect');
  await page.waitForFunction(()=>document.getElementById('scanLogStatus')?.textContent==='Logs active');
  const badge=await page.locator('#scanLogStatus').boundingBox();
  assert.ok(badge.x>=0 && badge.x+badge.width<=390,'logging badge stays inside phone viewport');
  // First run on a fresh phone: the gate asks for one tap before the camera.
  const startTap = page.locator("#startCameraTap");
  if (await startTap.isVisible()) await startTap.click();
  recognizing=true;
  // Batch language IT → the western family only; the japanese/chinese rows of
  // the same artwork are never offered.
  await page.waitForFunction(()=>document.querySelectorAll('.sc-tile').length===5);
  await page.getByRole('button',{name:'Prismatic Evolutions, card 105/131',exact:true}).click();
  await page.waitForFunction(()=>!document.body.classList.contains('sc-picking'));
  const until=Date.now()+5000;while(!uploads.length && Date.now()<until)await new Promise(r=>setTimeout(r,50));
  assert.equal(uploads.length,1);assert.equal(uploads[0].printing.cardId,'633460');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('pokoin.scanDiagnostics.v2')||'{}').sequence>3);
  // Hold heartbeats offline, generate a diagnostic, reload, then restore connectivity.
  dropHeartbeats=true;
  await page.evaluate(()=>window.scanDiagnostics('test-before-reload',null,{error:'AbortError'}));
  await page.reload();
  await page.waitForFunction(()=>document.getElementById('scanLogStatus')?.textContent==='Logs pending');
  const pending=await page.evaluate(()=>JSON.parse(localStorage.getItem('pokoin.scanDiagnostics.v2')).entries.some(e=>e.kind==='test-before-reload'));
  assert.equal(pending,true);
  dropHeartbeats=false;recognizing=false;
  await page.waitForFunction(()=>document.getElementById('scanLogStatus')?.textContent==='Logs active',{},{timeout:10000});
  assert.ok(logs.some(e=>e.kind==='test-before-reload'));
  assert.ok(logs.some(e=>e.kind==='gate' && e.hits.length===2 && e.gateAfter));
  assert.ok(logs.some(e=>e.kind==='printing-response' && e.offered.length===5 && !e.offered.includes('900') && !e.offered.includes('901')));
  assert.ok(logs.some(e=>e.kind==='printing-choice' && e.chosen==='633460'));
  assert.ok(logs.every(e=>e.sessionId==='browser-session'));
  assert.equal(new Set(logs.map(e=>`${e.runId}:${e.sequence}`)).size,logs.length);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});

test('a paired phone with a denied camera sees the Start tap, then the Safari fix',async()=>{
 const store={
  heartbeat:async({token})=>{if(token!=='test-phone-token')throw Object.assign(new Error('gone'),{statusCode:401});return {sessionId:'denied-session',batchId:'denied-batch',serverTime:Date.now(),paused:false,received:0};},
  resolvePrintingsForPhone:async()=>({choose:false,printings:[]}),
  ingestScan:async()=>({received:1}),
 };
 const target=path.resolve(__dirname,'../../pokoin-api/scan-phone.js');
 const Mod=require('node:module');
 const original=Mod._load;
 Mod._load=function(request,parent,isMain){
  if(parent?.filename===target && request==='./_scan_store')return {getScanStore:()=>store};
  if(parent?.filename===target && request==='./_scan_diagnostics')return {...diagnostic,recordDiagnostics:()=>[]};
  return original.call(this,request,parent,isMain);
 };
 let handler;try{delete require.cache[target];handler=require(target);}finally{Mod._load=original;}
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/scan-phone'){let body='';for await(const chunk of req)body+=chunk;req.body=JSON.parse(body||'{}');return handler(req,res);}
  if(url.pathname==='/api/scan/catalogs'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({catalogs:[{id:'pokemon_generic'}]}));return;}
  if(url.pathname==='/api/scan/identify'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,hits:[],boxes:[],top1:null}));return;}
  const file=url.pathname.startsWith('/static/')?path.join(WEB,url.pathname):path.join(WEB,'index.html');
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.png')?'image/png':'text/html');fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addInitScript(()=>{
  localStorage.setItem('pokoin.scanConnect.v1',JSON.stringify({token:'test-phone-token',sessionId:'denied-session'}));
  window.SCAN_CONNECT_API=location.origin;window.CARDSCAN_API=location.origin+'/api/scan';
  // iOS sticky denial: the prompt never shows and getUserMedia always refuses.
  const refuse=async()=>{const e=new Error('rejected');e.name='NotAllowedError';throw e;};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:refuse,enumerateDevices:async()=>[]},configurable:true});
  Object.defineProperty(navigator,'permissions',{value:{query:async()=>({state:'denied'})},configurable:true});
 });
 try{
  const page=await context.newPage();
  await page.goto(base+'/connect');
  // The stored-token path must meet the gated startCam: tap, not a dead camera.
  await page.waitForFunction(()=>document.getElementById('warming')?.textContent==='Tap to start the camera.');
  assert.equal(await page.locator('#startCameraTap').isVisible(),true);
  await page.locator('#startCameraTap').click();
  await page.waitForFunction(()=>/Camera blocked/.test(document.getElementById('warming')?.textContent||''));
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
