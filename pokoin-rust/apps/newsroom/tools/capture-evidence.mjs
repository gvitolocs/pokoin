// Development reference capture: buildStoryPack performs public GETs only.
// Never call publishStoryArticle: even its dryRun path can save editor memory.
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const [root,scheduleFile,output]=process.argv.slice(2);
const f=JSON.parse(await fs.readFile(scheduleFile,'utf8'));
const {buildStoryPack}=await import(pathToFileURL(`${root}/src/newsroom/pipeline.js`));
const {deterministicHints,validTemplatesFor}=await import(pathToFileURL(`${root}/src/newsroom/templates.js`));
const {editorialWorthiness}=await import(pathToFileURL(`${root}/src/newsroom/publication.js`));
const {reporterMemoryFor}=await import(pathToFileURL(`${root}/src/newsroom/memory.js`));
const row=f.expected.games.find(r=>r.game==='magic'&&r.candidates.length);
if(!row)throw new Error('no open Magic candidate');
const story=structuredClone(f.stories.find(s=>s.id===row.candidates[0]));
const now=new Date(f.now);
let gets=0;
const fetchImpl=async(url,options={})=>{
 if(options.method&&options.method!=='GET')throw new Error('capture permits GET only');
 gets++; return fetch(url,options);
};
const {pack}=await buildStoryPack(story,{now,fetchImpl});
const hints=deterministicHints(pack,{now});
const worthiness=editorialWorthiness({pack,hints,now,allowSingleSpecialist:true});
const memory=await reporterMemoryFor({game:story.game,dataDir:process.env.NEWSROOM_CAPTURE_DATA_DIR});
await fs.writeFile(output,JSON.stringify({now:f.now,story,pack,hints,validTemplates:validTemplatesFor(hints),memory,worthiness,getRequests:gets},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({story:story.id,sourceDocuments:pack.sourceDocs.length,claims:pack.claimLedger.length,worthiness,gets,modelCalls:0}));
