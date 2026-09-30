#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const base='/home/nez/Projects/cardvault/pokemon_card_vault';
const {Pool}=require(base+'/node_modules/pg');
const {MARKETPLACE_MEILI_SYNC_SELECT,mapMarketplaceMeiliDoc}=require(base+'/api/_meili_document');
const root=process.env.POKOIN_CATALOG_RUN_ROOT||'/home/nez/data/pokoin-catalog-refresh/'+new Date().toISOString().slice(0,10);
const env=Object.fromEntries(JSON.parse(cp.execFileSync('docker',['inspect','pokoin-marketplace-postgres-15t','--format','{{json .Config.Env}}'],{encoding:'utf8'})).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)]}));
const upload="import json,subprocess,sys,time,urllib.request\nenvlist=json.loads(subprocess.check_output([\"docker\",\"inspect\",\"pokoin-oracle-api\",\"--format\",\"{{json .Config.Env}}\"]))\nenv=dict(x.split(\"=\",1) for x in envlist)\nhost=env.get(\"MEILI_HOST\") or env.get(\"MEILISEARCH_HOST\")\nkey=env.get(\"MEILI_API_KEY\") or env.get(\"MEILISEARCH_API_KEY\")\nindex=env.get(\"MEILI_MARKETPLACE_INDEX\",\"marketplace_cards\")\nif not host or not key:raise SystemExit(\"Meili configuration missing\")\ndef request(route,data=None):\n headers={\"Authorization\":\"Bearer \"+key,\"Content-Type\":\"application/json\"}\n req=urllib.request.Request(host.rstrip(\"/\")+route,data=None if data is None else json.dumps(data).encode(),headers=headers)\n with urllib.request.urlopen(req,timeout=120) as r:return json.load(r)\ndocs=json.load(sys.stdin);task=request(\"/indexes/\"+index+\"/documents\",docs)\nuid=task[\"taskUid\"]\nfor _ in range(120):\n status=request(\"/tasks/\"+str(uid))\n if status[\"status\"] in (\"succeeded\",\"failed\",\"canceled\"):\n  print(json.dumps({\"taskUid\":uid,\"status\":status[\"status\"],\"documents\":len(docs),\"error\":status.get(\"error\")}))\n  if status[\"status\"]!=\"succeeded\":raise SystemExit(1)\n  break\n time.sleep(1)\nelse:raise SystemExit(\"Meili task timeout\")\n";
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function main(){
 const pool=new Pool({host:'127.0.0.1',port:25432,user:env.POSTGRES_USER,password:env.POSTGRES_PASSWORD,database:'pokoin_marketplace',max:1,options:'-c statement_timeout=180000'});
 const stateFile=path.join(root,'picture-sync-state.json'), state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
 const ids=[...new Set(Object.keys(state).filter(k=>!k.includes('/')).map(k=>Number(k.split('_')[0])).filter(Number.isSafeInteger))];
 const {rows}=await pool.query(MARKETPLACE_MEILI_SYNC_SELECT+" where c.projected_at >= $1::timestamptz OR c.ct_id=ANY($2::bigint[]) order by c.card_id",[new Date(root.split('/').pop()).toISOString(),ids]);
 const docs=rows.map(mapMarketplaceMeiliDoc);await pool.end();
 const results=[];
 for(let i=0;i<docs.length;i+=1000){
  const result=cp.spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=20','pi-home','python3 -c '+quote(upload)],{input:JSON.stringify(docs.slice(i,i+1000)),encoding:'utf8',maxBuffer:1024*1024,timeout:240000});
  if(result.status!==0)throw Error(result.stderr||result.stdout||'Meili upload failed');
  console.log(result.stdout.trim());results.push(JSON.parse(result.stdout));
 }
 fs.writeFileSync(path.join(root,'search-sync-status.json'),JSON.stringify({documents:docs.length,tasks:results,finishedAt:new Date().toISOString()},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
