#!/usr/bin/env node
// Runs on nezopt. Oracle only supplies GET responses; all SQL and raw dumps stay here.
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), readline=require('node:readline');
const sibling='/home/nez/Projects/cardvault/pokemon_card_vault';
const importer=require(sibling+'/scripts/cardtrader-multigame-import.js');
const {Pool}=require(sibling+'/node_modules/pg');
const apply=process.argv.includes('--apply');
const root=process.env.POKOIN_CATALOG_RUN_ROOT||'/home/nez/data/pokoin-catalog-refresh/'+new Date().toISOString().slice(0,10);
fs.mkdirSync(root,{recursive:true});
const env=Object.fromEntries(JSON.parse(cp.execFileSync('docker',['inspect','pokoin-marketplace-postgres-15t','--format','{{json .Config.Env}}'],{encoding:'utf8'})).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
const poolFor=db=>new Pool({host:'127.0.0.1',port:25432,user:env.POSTGRES_USER,password:env.POSTGRES_PASSWORD,database:db,max:4,connectionTimeoutMillis:15000,options:'-c statement_timeout=300000 -c lock_timeout=60000'});
const bridge=fs.readFileSync(path.join(__dirname,'cardtrader-fetch-bridge.py'),'utf8');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const remote=cp.spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=20','pokoin-marketplace','python3 -u -c '+quote(bridge)],{stdio:['pipe','pipe','inherit']});
let seq=0; const pending=new Map(), cache=new Map();
readline.createInterface({input:remote.stdout}).on('line',line=>{try{const msg=JSON.parse(line),p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error)):p.resolve(msg.data);}}catch(e){console.error('Bridge protocol failure:',e.message);}});
remote.on('exit',code=>{for(const p of pending.values())p.reject(Error('GET bridge exited '+code));pending.clear();});
const api={get:(endpoint,params={})=>{const key=endpoint+JSON.stringify(params);if(cache.has(key))return cache.get(key);const filename=path.join(root,endpoint.replaceAll('/','_')+'-'+(params.expansion_id||params.game_id||'all')+'.json');
const promise=fs.existsSync(filename)?Promise.resolve(JSON.parse(fs.readFileSync(filename,'utf8'))):new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve:data=>{fs.writeFileSync(filename,JSON.stringify(data));resolve(data);},reject});remote.stdin.write(JSON.stringify({id,path:endpoint,params})+'\n');});
cache.set(key,promise);return promise;}};
async function definition(pool,name){const r=await pool.query('select pg_get_functiondef(oid) as body from pg_proc where proname=$1',[name]);if(r.rows.length!==1)throw Error('Missing unique projection '+name);return r.rows[0].body;}
function insertOnly(def,table){const start=def.indexOf('insert into public.'+table+' (');if(start<0)throw Error('Missing insert '+table);const tail=def.slice(start);const conflict=tail.indexOf('on conflict (card_id)');if(conflict>=0)return tail.slice(0,conflict)+'on conflict (card_id) do nothing;';const end=tail.indexOf(';');return tail.slice(0,end)+' on conflict (card_id) do nothing;';}
async function project(pool,target,categories){
 if(target.cardtraderGameId===5){
  await pool.query("INSERT INTO pokoin_pokemon_expansions (expansion_id,game_id,code,name,normalized_name,compact_name,name_tokens) SELECT DISTINCT expansion_id,5,expansion->>'code',expansion->>'name',marketplace_search_normalize(expansion->>'name'),marketplace_search_compact(expansion->>'name'),marketplace_search_tokenize(expansion->>'name') FROM pokoin_pokemon_blueprints b WHERE expansion_id IS NOT NULL AND expansion->>'name' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pokoin_pokemon_expansions e WHERE e.expansion_id=b.expansion_id) ON CONFLICT DO NOTHING");

  console.log('PROJECT names');
  await pool.query("insert into public.marketplace_card_names (name,normalized_name,compact_name,emoji,name_tokens,updated_at) select distinct name,marketplace_search_normalize(name),marketplace_search_compact(name),'',marketplace_search_tokenize(name),now() from public.pokoin_pokemon_blueprints where name<>'' AND NOT EXISTS(SELECT 1 FROM marketplace_card_names n WHERE n.name=pokoin_pokemon_blueprints.name) on conflict(name) do nothing");
  let sql=insertOnly(await definition(pool,'refresh_marketplace_cards_from_blueprints'),'marketplace_cards');
  sql=sql.replace('from public.pokoin_pokemon_blueprints b','from public.pokoin_pokemon_blueprints b WHERE NOT EXISTS (SELECT 1 FROM public.marketplace_cards old WHERE old.ct_id=b.id)');
  // Current CT identities carry rarity and collector number in fixed_properties.
  sql=sql.replace("coalesce(nullif(b.blueprint->>'rarity', '')","coalesce(nullif(b.blueprint->'fixed_properties'->>'pokemon_rarity',''), nullif(b.blueprint->>'rarity', '')");
  sql=sql.replace("coalesce(nullif(b.blueprint->>'number', '')","coalesce(nullif(b.blueprint->'fixed_properties'->>'collector_number',''), nullif(b.blueprint->>'number', '')");
  console.log('PROJECT',sql.slice(0,65));await pool.query(sql);
  for(const [fn,table] of [['refresh_marketplace_search_candidates','marketplace_search_candidates'],['refresh_marketplace_card_versions','marketplace_card_versions']]){
   sql=insertOnly(await definition(pool,fn),table);
   sql=sql.replace('where coalesce(c.preview_image_url','where NOT EXISTS (SELECT 1 FROM public.'+table+' old WHERE old.card_id=c.card_id) AND coalesce(c.preview_image_url');
   if(table==='marketplace_search_candidates')sql=sql.replace('card_id, name, set_name','card_id, ct_id, name, set_name').replace('c.card_id,\n    c.name','c.card_id,\n    c.ct_id,\n    c.name');
   console.log('PROJECT',sql.slice(0,65));await pool.query(sql);
  }
  sql=insertOnly(await definition(pool,'refresh_marketplace_card_urls'),'marketplace_card_urls');
  sql=sql.replace('on sc.card_id = c.card_id','on sc.card_id = c.card_id WHERE NOT EXISTS (SELECT 1 FROM public.marketplace_card_urls old WHERE old.card_id=c.card_id)');
  console.log('PROJECT',sql.slice(0,65));await pool.query(sql);
  await pool.query('select refresh_marketplace_set_catalog_counts()');
 }else{
  const def=await definition(pool,'refresh_multigame_marketplace_projections');
  let sql=def.split('execute format($sql$')[1]?.split('$sql$, qualified_raw)')[0];
  if(!sql)throw Error('Unexpected multigame function structure');
  sql=sql.replace('from %s b','from '+target.schema+'.cardtrader_blueprints b');
  sql=sql.slice(0,sql.indexOf('on conflict (card_id)'))+'on conflict (card_id) do nothing';
  const singles=categories.filter(c=>/singles?|cards?|oversiz|promo/i.test(c.name||'')).map(c=>Number(c.id));
  const keys=[target.game+'_rarity','rarity','pokemon_rarity'];
  await pool.query(sql,[singles,keys]);
  const urlStart=def.indexOf('insert into public.marketplace_card_urls (');
  let urls=def.slice(urlStart).split('return refreshed_count')[0].trim();
  urls=urls.replace('from public.marketplace_search_candidates c','from public.marketplace_search_candidates c WHERE NOT EXISTS (SELECT 1 FROM public.marketplace_card_urls old WHERE old.card_id=c.card_id)');
  urls=urls.replace(/;\s*$/,' on conflict (card_id) do nothing;');
  await pool.query(urls);
 }
}
async function main(){
 const admin=poolFor('pokoin_marketplace'), games=await api.get('/games'), categories=await api.get('/categories');
 const dbs=(await admin.query("select datname from pg_database where datname like 'pokoin_%' order by (datname='pokoin_marketplace') desc,datname")).rows;
 const report={skipped:[],startedAt:new Date().toISOString(),apply,games:[],errors:[]};
 const only=process.argv.find(a=>a.startsWith('--database='))?.split('=')[1];
 for(const {datname:db} of dbs){
  if(only&&db!==only)continue;
  const pool=poolFor(db);
  try{
   let schema='public',table='pokoin_pokemon_blueprints',gameId=5;
   if(db!=='pokoin_marketplace'){
    const schemas=(await pool.query("select table_schema from information_schema.tables where table_name='cardtrader_blueprints' and table_schema like 'marketplace_%'")).rows;
    if(schemas.length!==1){report.skipped.push({database:db,reason:'Empty placeholder database; no live catalogue'});continue;}
    schema=schemas[0].table_schema;table='cardtrader_blueprints';
    gameId=Number((await pool.query('select game_id from '+schema+'.'+table+' where game_id is not null limit 1')).rows[0]?.game_id);
    if(!gameId)throw Error('Empty game mapping '+db);
   }
   const game=games.find(g=>Number(g.id)===gameId);if(!game)throw Error('Unknown CT game '+gameId);
   const target={game:schema.replace('marketplace_',''),slug:db==='pokoin_marketplace'?'pokemon':db.slice(7).replaceAll('_','-'),displayName:game.name,cardtraderGameId:gameId,cardtraderCategoryId:null,categoryName:'',databaseUrlEnv:'UNUSED_CATALOG_DATABASE_URL',schema,table,cdnKeyPrefix:db==='pokoin_marketplace'?'':db.slice(7).replaceAll('_','-')+'/',refreshSql:'',syncCommand:''};
   fs.writeFileSync(path.join(root,db+'-target.json'),JSON.stringify(target,null,2));
   const options=importer.parseArgs(['--game='+target.game,'--stream-all','--limit=all','--concurrency=4']);
   console.log(new Date().toISOString(),'AUDIT',db,game.name);
   let dry=await importer.run(options,{pool,target,api});
   for(let retry=0;dry.counts.failedExpansions&&retry<2;retry++){for(const p of dry.expansionProgress.filter(p=>p.error))cache.delete('/blueprints/export'+JSON.stringify({expansion_id:p.expansion_id}));dry=await importer.run(options,{pool,target,api});}
   if(dry.counts.failedExpansions)throw Error('Unfetched expansions: '+dry.counts.failedExpansions);
   fs.writeFileSync(path.join(root,db+'-dry.json'),JSON.stringify(dry,null,2));
   if(dry.blockers?.length||dry.errors?.length)throw Error('Dry-run errors '+JSON.stringify(dry.errors||dry.blockers));
   console.log(new Date().toISOString(),'PLAN',db,JSON.stringify(dry.counts));
   let result=dry;
   if(apply){
    result=await importer.run({...options,apply:true},{pool,target,api});
    if(result.counts.failedExpansions)throw Error('Import errors '+result.counts.failedExpansions);
    await project(pool,target,categories.filter(c=>Number(c.game_id)===gameId));
   }
   const entry={database:db,gameId,name:game.name,counts:result.counts,finishedAt:new Date().toISOString()};
   report.games.push(entry);
   console.log(new Date().toISOString(),'DONE',db,JSON.stringify(result.counts));
  }catch(e){report.errors.push({database:db,error:e.message});console.error(new Date().toISOString(),'FAIL',db,e.message);}
  finally{await pool.end();fs.writeFileSync(path.join(root,only?'pokemon-status.json':'status.json'),JSON.stringify(report,null,2));}
 }
 await admin.end(); remote.stdin.end(); report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(root,only?'pokemon-status.json':'status.json'),JSON.stringify(report,null,2));
 if(report.errors.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);remote.kill();process.exitCode=1;});
