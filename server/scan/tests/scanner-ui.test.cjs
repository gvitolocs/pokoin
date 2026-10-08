const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function scanner(options={}) {
  const draws = [], navigations = [], requests = [], timers = [], rects = [], paths = [], rotates = [], blobs = [];
  const ctx = {clearRect(){}, strokeRect(...args){rects.push(args);}, drawImage(...args){draws.push(args);},
    save(){}, restore(){}, translate(){}, rotate(...args){rotates.push(args);},
    beginPath(){}, moveTo(...args){paths.push(['M', ...args]);}, lineTo(...args){paths.push(['L', ...args]);},
    closePath(){}, stroke(){}, fillRect(){}};
  const elements = new Map();
  const listeners = new Map();
  function node(id='') {
    const classes=new Set();
    return { hidden:id==='shot', clientWidth:390,clientHeight:680,videoWidth:1280,videoHeight:720,
      attributes:{},children:[],textContent:'',
      classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k),toggle(k,on){if(on)classes.add(k);else classes.delete(k)}},
      setAttribute(k,v){this.attributes[k]=v},getAttribute(k){return this.attributes[k]},removeAttribute(k){delete this.attributes[k]},
      append(...items){this.children.push(...items)},replaceChildren(...items){this.children=items},addEventListener(){},
      getContext(){return ctx},toBlob(callback){const size={width:this.width,height:this.height};blobs.push(size);callback(size);},
    };
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id,node(id));
    return elements.get(id);
  }
  const track = {stop(){},getSettings:()=>({deviceId:"rear"}),applyConstraints: async constraints => requests.push(constraints)};
  const sandbox = {
    document: {getElementById:element, createElement:()=>node(), querySelector:()=>null, querySelectorAll:()=>[]},
    navigator: {mediaDevices:{getUserMedia: async constraints => {
      requests.push(constraints.video); return {getVideoTracks:()=>[track],getTracks:()=>[track]};
    }}},
    window: {addEventListener(type,fn,options){const list=listeners.get(type)||[];list.push({fn,once:!!(options&&options.once)});listeners.set(type,list);}},
    screen:{}, devicePixelRatio:1,
    location:{hostname:'scan.pokoin.com',href:options.href||'https://scan.pokoin.com/',assign:url=>navigations.push(url)},
    performance:{now:()=>0}, requestAnimationFrame:()=>1,
    setTimeout:callback=>{timers.push(callback); return timers.length;}, clearTimeout(){},
    AbortController, AbortSignal,
    cancelAnimationFrame(){},
    history:{replaceState(_a,_b,url){sandbox.location.href=String(url)}},
    fetch:async()=>({ok:true,json:async()=>({catalogs:['pokemon_western','pokemon_japanese','pokemon_chinese','pokemon_generic','one_piece_english','one_piece_japanese','one_piece_singles','riftbound_western'].map(id=>({id}))})}),
    URL, FormData:class {append(){}},
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source,context);
  const dispatch=(type,event={})=>{
    const list=listeners.get(type)||[];
    for(const entry of list.slice()){
      if(entry.once){const index=list.indexOf(entry);if(index>=0)list.splice(index,1);}
      entry.fn(event);
    }
  };
  return {run:code=>vm.runInContext(code,context),sandbox,elements,element,draws,navigations,requests,timers,rects,paths,rotates,blobs,listeners,dispatch};
}

// Card links open the full path; numeric pokoin.com/{id} short links 404 on the static host.
const fullCardUrl=(prefix,id)=>`https://pokoin.com/${prefix}marketplace/en/cards/${id}`;
test('portrait preview and capture keep the entire sensor frame without software zoom',async()=>{
 const s=scanner();
 assert.match(html,/#live \{ object-fit: contain;/);
 const blob=await s.run('blobFromCanvas(live,960)');
 assert.deepEqual(blob,{width:960,height:540});
 assert.deepEqual(s.draws[0].slice(1),[0,0,1280,720,0,0,960,540]);
 const box=s.run('mapContain([0,0,960,540],960,540,390,680)');
 assert.equal(box.x,0);assert.equal(box.w,390);assert.equal(box.h,219.375);assert.equal(box.y,230.3125);
});
test('sensor constraints stay in primary orientation during portrait, landscape and browser chrome resizing',async()=>{
 const s=scanner();await turn();const initial=JSON.stringify(s.run('cameraConstraints()'));
 assert.equal(s.run('cameraConstraints().width.ideal'),1280);
 assert.equal(s.run('cameraConstraints().height.ideal'),960);
 assert.equal(s.run('cameraConstraints().aspectRatio.ideal'),4/3);
 assert.equal(s.run('cameraConstraints().resizeMode.ideal'),'none');
 const before=s.requests.length;
 for(const [w,h] of [[680,390],[390,500],[390,664]]){
  Object.assign(s.element('overlay'),{clientWidth:w,clientHeight:h});
  s.run('cameraViewChanged()');
  assert.equal(JSON.stringify(s.run('cameraConstraints()')),initial);
 }
 assert.equal(s.requests.length,before);
});
test('portrait native frame retains all pixels and aligns the detected box without rotation or zoom',async()=>{
 const s=scanner();Object.assign(s.element('live'),{videoWidth:960,videoHeight:1280});
 assert.deepEqual(await s.run('blobFromCanvas(live,960)'),{width:720,height:960});
 assert.deepEqual(s.draws[0].slice(1),[0,0,960,1280,0,0,720,960]);
 const box=s.run('mapContain([180,240,540,720],720,960,390,664)');
 assert.equal(box.x,97.5);assert.equal(box.y,202);assert.equal(box.w,195);assert.equal(box.h,260);
});

test('pokemon lock overlay snaps YOLO box to 63:88 card aspect',()=>{
 const s=scanner();
 const tall=s.run('fitPokemonCardRect({x:100,y:100,w:100,h:300})');
 assert.ok(Math.abs(tall.w / tall.h - 63/88) < 1e-6);
 assert.equal(tall.h, 300);
 assert.ok(Math.abs(tall.w - 300 * 63/88) < 1e-6);
 const wide=s.run('fitPokemonCardRect({x:0,y:0,w:200,h:100})');
 assert.ok(Math.abs(wide.w / wide.h - 63/88) < 1e-6);
 assert.equal(wide.w, 200);
});

test('gallery keeps the full image without applying the camera crop',async()=>{
  const s=scanner();
  const blob=await s.run('blobFromCanvas({naturalWidth:1600,naturalHeight:900},1280)');
  assert.deepEqual(blob,{width:1280,height:720});
  assert.deepEqual(s.draws[0].slice(1),[0,0,1600,900,0,0,1280,720]);
});

test('a delayed response from before rotation cannot draw boxes or navigate',async()=>{
  const s=scanner();
  await new Promise(resolve=>setImmediate(resolve));
  let reply;
  s.sandbox.fetch=()=>new Promise(resolve=>{reply=resolve;});
  const pending=s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
  s.run('invalidateCameraView()');
  reply({ok:true,json:async()=>({immediate:true,img_w:960,img_h:540,
    boxes:[{xyxy:[100,100,200,300]}],hits:[{pokoin_url:'https://pokoin.com/card/123'}]})});
  assert.equal(await pending,null);
  assert.equal(s.run('lastBoxes'),null);
  assert.deepEqual(s.navigations,[]);
});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('all six catalog choices route to their own API and game-specific language controls',async()=>{
 const s=scanner();await turn();
 for(const [game,language] of [['pokemon','western'],['pokemon','japanese'],['pokemon','chinese'],['one_piece','english'],['one_piece','japanese'],['riftbound','western']]){
  s.run(`selectCatalog(${JSON.stringify(game)},${JSON.stringify(language)})`);
  assert.equal(new URL(s.run('identifyEndpoint(true)')).searchParams.get('catalog'),game+'_'+language);
  assert.equal(s.element('langCn').hidden,game!=='pokemon');
  assert.equal(s.element('langJp').hidden,game==='riftbound');
 }
});
test('generic singles and one piece singles catalogs are extra leftover-JPEG galleries',async()=>{
 const s=scanner();await turn();
 s.run('selectCatalog("pokemon","generic")');
 assert.equal(new URL(s.run('identifyEndpoint(true)')).searchParams.get('catalog'),'pokemon_generic');
 assert.equal(s.element('langExtra').hidden,false);
 assert.equal(s.element('langExtra').textContent,'GS');
 s.run('selectCatalog("one_piece","singles")');
 assert.equal(new URL(s.run('identifyEndpoint(true)')).searchParams.get('catalog'),'one_piece_singles');
 assert.equal(s.element('langExtra').textContent,'SG');
 s.run('selectCatalog("riftbound","western")');
 assert.equal(s.element('langExtra').hidden,true);
});
test('switching catalog discards an in-flight match',async()=>{
 const s=scanner();await turn();let reply;
 s.sandbox.fetch=()=>new Promise(resolve=>reply=resolve);
 const pending=s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 s.run('selectCatalog("one_piece","japanese")');
 reply({ok:true,json:async()=>({catalog:'pokemon_western',immediate:true,top1:{id:'219698',public_id:'219698',score:.99,pokoin_url:'https://pokoin.com/219698'},boxes:[{xyxy:[1,2,3,4]}]})});
 assert.equal(await pending,null);assert.equal(s.run('lastBoxes'),null);assert.deepEqual(s.navigations,[]);
});
test('single navigation uses the top match only and rejects the wrong game hostname',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("one_piece","english")');
 assert.equal(s.run('pokoinUrl({top1:{public_id:"488352",pokoin_url:"https://onepiece.pokoin.com/488352"}})'), fullCardUrl('one-piece/','488352'));
 assert.equal(s.run('pokoinUrl({top1:{public_id:"488352",pokoin_url:"https://pokoin.com/488352"}})'), '');
 assert.equal(s.run('pokoinUrl({top1:{id:"not-mapped"},hits:[{public_id:"488352",pokoin_url:"https://onepiece.pokoin.com/488352"}]})'), '');
});
test('multi shows distinct detected cards without auto-navigation',async()=>{
 const s=scanner();await turn();s.run('setMode("multi")');
 const top={id:'219698',public_id:'219698',score:.99,pokoin_url:'https://pokoin.com/219698',name:'Oddish'};
 s.sandbox.fetch=async()=>({ok:true,json:async()=>({catalog:'pokemon_western',immediate:true,top1:top,hits:[top],cards:[{top1:top},{top1:{...top,id:'243376',public_id:'243376',pokoin_url:'https://pokoin.com/243376',name:'Grimer'}}]})});
 await s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 assert.equal(s.element('multiList').children.length,2);assert.deepEqual(s.navigations,[]);
});
test('gallery results arriving after a catalog switch are also ignored',async()=>{
 const s=scanner();await turn();let reply;s.sandbox.fetch=()=>new Promise(resolve=>reply=resolve);
 const pending=s.run('identify({}, {live:false})');s.run('selectCatalog("pokemon","chinese")');
 reply({ok:true,json:async()=>({catalog:'pokemon_western',top1:{id:'219698',public_id:'219698',score:.99,pokoin_url:'https://pokoin.com/219698'}})});
 assert.equal(await pending,null);assert.deepEqual(s.navigations,[]);
});

test('normal physical rear lens wins over telephoto, ultra-wide, virtual and front lenses',async()=>{
 const s=scanner();await turn();
 for(const normal of ['Back Camera','Back Wide Angle Camera','Bagsidekamera','Fotocamera posteriore grandangolare']){
  const labels=['Back Triple Camera','Back Telephoto Camera','Back Ultra Wide Camera','Front Camera',normal];
  const devices=labels.map((label,i)=>({kind:'videoinput',deviceId:String(i),label}));
  assert.equal(s.run(`preferredCamera(${JSON.stringify(devices)},"0").deviceId`),'4');
 }
 assert.equal(s.run('preferredCamera([{kind:"videoinput",deviceId:"a",label:""},{kind:"videoinput",deviceId:"b",label:""}],"b").deviceId'),'b');
});
test('camera startup reopens the normal lens, resets zoom and lets users select a different lens',async()=>{
 const s=scanner();await turn();const stopped=[],opened=[],applied=[];
 s.sandbox.navigator.mediaDevices={
  enumerateDevices:async()=>['Back Ultra Wide Camera','Back Wide Angle Camera','Back Telephoto Camera'].map((label,i)=>({kind:'videoinput',deviceId:String(i),label})),
  getUserMedia:async({video})=>{const id=video.deviceId?.exact||'0';opened.push(id);const track={stop:()=>stopped.push(id),getSettings:()=>({deviceId:id}),getCapabilities:()=>({zoom:{min:1,max:9},focusMode:['continuous']}),applyConstraints:async(c)=>applied.push(c)};return {getVideoTracks:()=>[track],getTracks:()=>[track]};}
 };
 await s.run('startCam()');assert.deepEqual(opened,['0','1']);assert.ok(stopped.includes('0'));
 assert.equal(s.element('cameraControls').hidden,false);assert.equal(s.element('cameraSelect').children.length,3);
 assert.equal(applied[0].width.ideal,1280);assert.equal(applied[0].height.ideal,960);assert.equal(applied[0].aspectRatio.ideal,4/3);assert.equal(applied[0].advanced[0].zoom,1);assert.equal(applied[0].advanced[0].focusMode,'continuous');
 await s.run('startCam("2")');assert.equal(opened.at(-1),'2');assert.equal(s.run('track.getSettings().deviceId'),'2');
});
test('late camera permission response is stopped after a newer camera request',async()=>{
 const s=scanner();await turn();let resolveOld;const stopped=[];
 const stream=id=>{const track={stop:()=>stopped.push(id),getSettings:()=>({deviceId:id})};return {getVideoTracks:()=>[track],getTracks:()=>[track]};};
 s.sandbox.navigator.mediaDevices={enumerateDevices:async()=>[],getUserMedia:async({video})=>video.deviceId.exact==='old'?new Promise(r=>resolveOld=r):stream('new')};
 const old=s.run('startCam("old")');await s.run('startCam("new")');resolveOld(stream('old'));await old;
 assert.deepEqual(stopped,['old']);assert.equal(s.run('track.getSettings().deviceId'),'new');
});
test('weak live match offers a clickable candidate without automatic navigation',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("one_piece","english")');
 const top={id:'489018',public_id:'489018',score:.715,name:'Monkey.D.Luffy',pokoin_url:'https://onepiece.pokoin.com/489018'};
 s.sandbox.fetch=async()=>({ok:true,json:async()=>({catalog:'one_piece_english',top1:top,boxes:[]})});
 await s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 assert.equal(s.element('multiList').children[0].href,fullCardUrl('one-piece/',top.public_id));assert.match(s.element('warming').textContent,/Possible match/);assert.deepEqual(s.navigations,[]);
});
test('the actual accepted Luffy API response opens its card on the first frame',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("one_piece","english")');
 const response=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/scanner-redirect/luffy-response.json'),'utf8'));
 assert.equal(response.immediate,false);assert.equal(response.top1.score,.78);
 s.sandbox.fetch=async()=>({ok:true,json:async()=>response});
 await s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 assert.deepEqual(s.navigations,[fullCardUrl('one-piece/',response.top1.public_id)]);
 assert.match(s.element('warming').textContent,/Opening/);
 assert.equal(s.element('multiList').children[0].href,fullCardUrl('one-piece/',response.top1.public_id));
});

test('browser chrome resize during identification does not discard a valid full-sensor response',async()=>{
 const s=scanner();await turn();let reply;
 s.run('selectCatalog("one_piece","english")');
 const response=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/scanner-redirect/luffy-response.json'),'utf8'));
 s.sandbox.fetch=()=>new Promise(resolve=>reply=resolve);
 const pending=s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 s.element('overlay').clientHeight=620;s.run('cameraViewChanged()');
 reply({ok:true,json:async()=>response});
 assert.ok(await pending);assert.deepEqual(s.navigations,[fullCardUrl('one-piece/',response.top1.public_id)]);
});
test('accepted Japanese gallery response opens the exact public card',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("one_piece","japanese")');
 const response=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/scanner-redirect/shanks-response.json'),'utf8'));
 s.sandbox.fetch=async()=>({ok:true,json:async()=>response});
 await s.run('identify({}, {live:false})');
 assert.deepEqual(s.navigations,[fullCardUrl('one-piece/',response.top1.public_id)]);
});
test('a failed navigation keeps a usable card link and explains the next action',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("one_piece","english")');
 const response=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/scanner-redirect/luffy-response.json'),'utf8'));
 s.sandbox.fetch=async()=>({ok:true,json:async()=>response});
 s.sandbox.location.assign=()=>{throw new Error('navigation denied')};
 await s.run('identify({}, {live:true,viewVersion:cameraViewVersion})');
 assert.equal(s.element('multiList').children[0].href,fullCardUrl('one-piece/',response.top1.public_id));
 assert.match(s.element('warming').textContent,/Tap.*open/);
});

test('a failed camera canvas capture is logged and the live loop schedules a retry',async()=>{
 const s=scanner();await turn();const logged=[];
 s.sandbox.window.scanDiagnostics=(kind,_data,context)=>logged.push([kind,context.error]);
 // VM doesn't provide DOMException; a named Error exercises the same retry path.
 s.run('blobFromCanvas = async () => { const error=new Error("capture failed"); error.name="InvalidStateError"; throw error; }');
 const count=s.timers.length;
 await s.run('tick()');
 assert.equal(s.run('busy'),false);
 assert.ok(s.timers.length>count,'next camera tick remains scheduled');
 assert.deepEqual(logged,[['camera-loop-error','InvalidStateError']]);
});
test('pokemon hits open the full card path, never the numeric short link',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("pokemon","western")');
 assert.equal(s.run('pokoinUrl({top1:{public_id:"531072",pokoin_url:"https://pokoin.com/531072"}})'), fullCardUrl('','531072'));
 assert.equal(s.run('pokoinUrl({top1:{public_id:"531072",pokoin_url:"https://riftbound.pokoin.com/531072"}})'), '');
 assert.equal(s.run('pokoinUrl({top1:{public_id:"5310x2",pokoin_url:"https://pokoin.com/5310x2"}})'), '');
});
test('single-origin pokoin_url forms open the card; a URL for another game never does',async()=>{
 const s=scanner();await turn();s.run('selectCatalog("riftbound","western")');
 for(const url of ['https://pokoin.com/riftbound/marketplace/en/cards/661762','https://pokoin.com/riftbound/661762','https://riftbound.pokoin.com/661762'])
  assert.equal(s.run(`pokoinUrl({top1:{public_id:"661762",pokoin_url:${JSON.stringify(url)}}})`), fullCardUrl('riftbound/','661762'), url);
 for(const url of ['https://pokoin.com/one-piece/marketplace/en/cards/661762','https://pokoin.com/marketplace/en/cards/661762','https://pokoin.com/riftbound/661763','https://evil.example/riftbound/661762'])
  assert.equal(s.run(`pokoinUrl({top1:{public_id:"661762",pokoin_url:${JSON.stringify(url)}}})`), '', url);
 s.run('selectCatalog("pokemon","western")');
 assert.equal(s.run('pokoinUrl({top1:{public_id:"531072",pokoin_url:"https://pokoin.com/marketplace/en/cards/531072"}})'), fullCardUrl('','531072'));
});

// iOS reports sticky activation across the Camera-app QR hop, so the gate
// never trusts activation: only a granted camera auto-starts.
test('an ungranted camera waits for the Start camera tap',async()=>{
 const s=scanner();
 s.run('cameraRequestVersion += 1'); // retire the eval-time start; only the gate decides now
 let gated=0;
 s.sandbox.navigator.mediaDevices={getUserMedia:async()=>{gated++;return {getVideoTracks:()=>[],getTracks:()=>[]};}};
 s.sandbox.window.startCam();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(gated,0,'no blind getUserMedia without a grant');
 assert.equal(s.element('startCameraTap').hidden,false);
 assert.equal(s.element('warming').textContent,'Tap to start the camera.');
});
test('a granted camera auto-starts; tap start works where the gate ran',async()=>{
 const granted=scanner();let grantedCalls=0;
 granted.run('cameraRequestVersion += 1');
 granted.sandbox.navigator.permissions={query:async()=>({state:'granted'})};
 granted.sandbox.navigator.mediaDevices={getUserMedia:async()=>{grantedCalls++;return {getVideoTracks:()=>[],getTracks:()=>[]};}};
 granted.sandbox.window.startCam();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(grantedCalls,1,'granted phones auto-start');
 const prompted=scanner();let promptedCalls=0;
 prompted.run('cameraRequestVersion += 1');
 prompted.sandbox.navigator.permissions={query:async()=>({state:'prompt'})};
 prompted.sandbox.navigator.mediaDevices={getUserMedia:async()=>{promptedCalls++;return {getVideoTracks:()=>[],getTracks:()=>[]};}};
 prompted.sandbox.window.startCam();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(promptedCalls,0,'the gate never fires getUserMedia on prompt state');
});
test('the Open in Chrome hop survives pairing and is removed only when the camera starts',()=>{
 const connectJs=fs.readFileSync(path.join(__dirname,'..','web','static','scan-connect.js'),'utf8');
 assert.doesNotMatch(connectJs,/tip\.remove\(\)/,'pairing no longer removes the hop');
 assert.match(html,/getElementById\("scOpenBrowser"\)/,'startCam removes the hop on stream success');
 assert.match(html,/id="startCameraTap"/,'the Start camera tap ships in the dock');
 assert.match(html,/Tap to start the camera\./);
});

// Device-orientation uprighting: the phone rolls, the YOLO box is axis-aligned
// in a rotated upload, so the phone un-rotates the frame and the overlay polygon.
test('uprightRoll reads world up in screen axes and returns nothing for a flat phone',()=>{
  const s=scanner();
  const upright=s.run('uprightRoll(90,0,0)');
  assert.ok(Math.abs(upright.roll)<1e-9);assert.ok(Math.abs(upright.strength-1)<1e-9);
  assert.equal(s.run('uprightRoll(0,0,0)'),null,'a flat phone says nothing about card rotation');
  const landscape=s.run('uprightRoll(0,-90,90)');
  assert.ok(Math.abs(landscape.roll)<1e-6);assert.ok(Math.abs(landscape.strength-1)<1e-6);
  const upsideDown=s.run('uprightRoll(90,0,180)');
  assert.ok(Math.abs(Math.abs(upsideDown.roll)-180)<1e-6);
  assert.equal(s.run('uprightRoll(NaN,0,0)'),null);
  assert.equal(s.run('uprightRoll(0,undefined,0)'),null);
});
test('tilt=off pins the roll to zero while an upright phone reports its tilt',()=>{
  const off=scanner({href:'https://scan.pokoin.com/?tilt=off'});
  off.dispatch('deviceorientation',{beta:70,gamma:-90});
  assert.equal(off.run('currentRoll()'),0);
  const on=scanner();
  on.dispatch('deviceorientation',{beta:70,gamma:-90});
  assert.ok(Math.abs(on.run('currentRoll()')-20)<0.5,'a 20 degree phone tilt becomes a 20 degree roll');
});
test('a rolled live tick uploads the rotated bounding box and rotates the canvas by -roll',async()=>{
  const s=scanner();await turn();
  s.dispatch('deviceorientation',{beta:70,gamma:-90});
  assert.ok(Math.abs(s.run('currentRoll()')-20)<0.5);
  await s.run('tick()');
  const rotated=s.blobs.at(-1);
  assert.equal(rotated.width,1087);assert.equal(rotated.height,836);
  assert.equal(s.rotates.length,1);
  assert.ok(Math.abs(s.rotates[0][0]-(-20*Math.PI/180))<1e-6);
});
test('a nearly upright frame stays on the plain full-frame upload',async()=>{
  const s=scanner();await turn();
  s.dispatch('deviceorientation',{beta:89,gamma:-90});
  await s.run('tick()');
  assert.deepEqual(s.blobs.at(-1),{width:960,height:540});
  assert.equal(s.rotates.length,0);
});
test('a rolled overlay strokes the rotated card polygon instead of an axis-aligned rect',async()=>{
  const s=scanner();await turn();
  s.rects.length=0;s.paths.length=0;
  s.run('drawBoxes([{xyxy:[100,100,300,380]}],1280,720,20,1280,720)');
  assert.equal(s.rects.length,0,'a rolled box is never an axis-aligned strokeRect');
  const move=s.paths.filter(p=>p[0]==='M'),line=s.paths.filter(p=>p[0]==='L');
  assert.equal(move.length,1);assert.equal(line.length,3);
  const pts=[move[0].slice(1),...line.map(p=>p.slice(1))];
  const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  assert.ok(Math.abs(dist(pts[0],pts[1])-dist(pts[2],pts[3]))<0.5,'opposite long sides stay equal');
  assert.ok(Math.abs(dist(pts[1],pts[2])-dist(pts[3],pts[0]))<0.5,'opposite short sides stay equal');
});
test('a late live response draws with the roll it was captured at, not the current sensor',async()=>{
  const s=scanner();await turn();
  s.dispatch('deviceorientation',{beta:70,gamma:-90});
  let reply;
  s.sandbox.fetch=()=>new Promise(resolve=>{reply=resolve;});
  const pending=s.run('identify({}, {live:true, viewVersion:cameraViewVersion, roll:20, frame:{w:1280,h:720}})');
  for(let i=0;i<20;i+=1)s.dispatch('deviceorientation',{beta:90,gamma:0});
  assert.equal(s.run('currentRoll()'),0,'the smoothed sensor settles back to upright');
  s.rects.length=0;s.paths.length=0;
  reply({ok:true,json:async()=>({catalog:'pokemon_western',img_w:1280,img_h:720,boxes:[{xyxy:[100,100,300,380]}],hits:[],top1:null})});
  assert.ok(await pending);
  assert.equal(s.rects.length,0);
  assert.equal(s.paths.filter(p=>p[0]==='M').length,1);
  assert.equal(s.paths.filter(p=>p[0]==='L').length,3);
});
test('iOS orientation permission is requested once from the first pointerdown, never at load',()=>{
  const s=scanner();
  let asked=0;
  s.sandbox.window.DeviceOrientationEvent=function(){};
  s.sandbox.window.DeviceOrientationEvent.requestPermission=()=>{asked+=1;return Promise.resolve('granted');};
  assert.equal(asked,0,'load must not prompt for motion access');
  s.dispatch('pointerdown',{});
  assert.equal(asked,1);
  s.dispatch('pointerdown',{});
  assert.equal(asked,1,'only the first gesture asks');
});
