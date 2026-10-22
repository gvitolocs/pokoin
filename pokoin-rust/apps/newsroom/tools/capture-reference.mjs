// Read-only Node oracle. Imported functions have injected providers; they never
// call a real model. Public GETs are the only live HTTP operations.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [root,dataDir,dest]=process.argv.slice(2);
if(!dest)throw new Error('usage: capture-reference.mjs NODE_ROOT DATA_DIR DEST');
await fs.mkdir(dest,{recursive:true});
const load=n=>import(pathToFileURL(`${root}/src/newsroom/${n}.js`));
const [cadence,games,claude,mod,sources,store]=await Promise.all(['cadence','games','claude','comment-moderation','sources','article-store'].map(load));
const now=new Date();
const read=async f=>JSON.parse(await fs.readFile(`${dataDir}/${f}`,'utf8'));
const [stories,records,state]=await Promise.all(['newsroom-site-stories.json','newsroom-articles-v1.json','newsroom-publisher-state.json'].map(read));
const rows=games.GAME_IDS.filter(id=>games.GAMES[id].newsActive).map(game=>{
 const slot=cadence.slotOpen(game,{records,attempts:state.attempts,now});
 return {game,slot,candidates:cadence.pickCandidates(game,{stories,records,now}).slice(0,slot.attemptsLeft||0).map(s=>s.id)};
});
const updates=records.filter(r=>r.status==='published').flatMap(record=>{
 const story=stories.find(s=>s.id===record.canonicalStoryId);if(!story)return [];
 const newest=Math.max(...story.sources.map(s=>Date.parse(s.added_at)));
 const last=Date.parse(state.updates[record.id]||0);
 return newest>Date.parse(record.dateModified)&&now-last>=12*3600e3?[{id:record.id,storyId:story.id,slug:record.slug}]:[];
});
const schedule={now:now.toISOString(),stories,records,state,expected:{games:rows,updates}};
await fs.writeFile(`${dest}/schedule.json`,JSON.stringify(schedule,null,2)+'\n');
const corpus=['','Pokémon','PokeBeach','Screen Rant','pokemonblog.com','https://pokemon.com/a','https://notpokemon.com','pokemon.com.evil.example','www.pokeguardian.com','x.com','IGN','randomblog.example','https://foo.limitlesstcg.com','screen rant news','youtube'];
await fs.writeFile(`${dest}/sources.json`,JSON.stringify(corpus.map(input=>({input,host:sources.resolveSourceHost(input),tier:sources.sourceTier(input)})),null,2)+'\n');
const comments=['DM me seller@example.com','call +39 123 456 7890','https://a.example https://b.example','Pokoin got this wrong','www.example.com','a123456789b'];
const decisions=['{"decision":"PUBLISH","reason":"ok"}','no json','{"decision":"maybe"}',{"decision":"hold","categories":[1,null,true,{},['x','y']]}];
await fs.writeFile(`${dest}/moderation.json`,JSON.stringify({prechecks:comments.map(input=>({input,expected:mod.precheck(input)})),decisions:decisions.map(input=>({input,expected:mod.parseDecision(input)}))},null,2)+'\n');
const pack={canonicalStoryId:'fixture',game:'magic',summaryOfEvent:'Set reveal',status:'multi_source',angle:'SET_REVEAL',sourceList:[{id:'s1',outlet:'IGN',tier:'C',title:'Set reveal',url:'https://ign.com/x'}],claimLedger:[],conflicts:[],confirmedClaims:[],pressClaims:[],unconfirmedClaims:[],dates:[],numbers:[],isUpdate:false,market:null,related:{cards:[],sets:[]},images:[]};
const skill=claude.loadSkill({root:`${root}/.claude/skills/poko-newsroom`});
const hints={sourceCount:1};const validTemplates=['breaking','explainer'];const memory='Desk lesson.';
const requests={};
const provider={name:'capture',models:{},strictSchema:true,generate:async req=>{requests[req.pass]=JSON.parse(req.user);return{ok:false,reason:'unavailable'};}};
const NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[now.toISOString()]));}static now(){return now.getTime();}};
await claude.draftArticle({pack,hints,validTemplates,reporterMemory:memory,provider,skill});
const previous={template:'breaking',headline:'Before',dek:'Before',blocks:[],datePublished:now.toISOString()};
await claude.draftArticle({pack,hints,validTemplates,reporterMemory:memory,provider:{...provider,generate:async req=>{requests.update=JSON.parse(req.user);return{ok:false,reason:'unavailable'};}},skill,previousArticle:previous});
const draft={...JSON.parse(JSON.stringify(claude.REPORTER_OUTPUT_SCHEMA.properties)),template:'breaking',headline:'Headline',dek:'Dek',articleType:'BREAKING',section:'sets',blocks:[],image_plan:{hero:'fallback',heroCardId:null,gallery:[]},related_entities:[],fact_check_status:null,analysis_required:false,market_module_required:false,first_reported_source_id:null,telegram:'',discord:'',x:'',notes:''};
await claude.editArticle({pack,draft,provider,skill});
await fs.writeFile(`${dest}/editorial.json`,JSON.stringify({now:now.toISOString(),pack,hints,validTemplates,memory,previous,draft,requests,trimmed:claude.trimmedPack(pack)},null,2)+'\n');
console.log(JSON.stringify({now:now.toISOString(),records:records.length,stories:stories.length,games:rows.length,modelCalls:0}));
