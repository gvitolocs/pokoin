// Development/reference capture only. No network requests, writes to Node state,
// model calls or publishing. The Rust binary only consumes JSON and text.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('usage: node capture-assets.mjs /path/to/reference');
const out = path.resolve(import.meta.dirname, '../assets');
const load = (name) => import(pathToFileURL(`${root}/src/newsroom/${name}.js`));
const [claude, games, sources, templates, schema, moderation] = await Promise.all(['claude', 'games', 'sources', 'templates', 'schema', 'comment-moderation'].map(load));
const skill = claude.loadSkill({ root: `${root}/.claude/skills/poko-newsroom` });
const values = {
  'reporter-schema': claude.REPORTER_OUTPUT_SCHEMA,
  'editor-schema': claude.EDITOR_OUTPUT_SCHEMA,
  games: Object.values(games.GAMES).map(g => ({...g, match: g.match.source, strong: g.strong?.source, exclude: g.exclude?.source})),
  'source-tiers': sources.SOURCE_TIERS,
  templates: templates.TEMPLATE_DEFS,
  contract: Object.fromEntries(Object.entries(schema).filter(([,v])=>typeof v !== 'function')),
};
for (const [name, value] of Object.entries(values)) await fs.writeFile(`${out}/${name}.json`, JSON.stringify(value, null, 2)+'\n');
for (const pass of ['reporter', 'editor']) await fs.writeFile(`${out}/${pass}-system.txt`, claude.systemPromptFor(pass, skill));
await fs.writeFile(`${out}/moderation-system.txt`, moderation.MODERATION_PROMPT);
const files = (await fs.readdir(`${root}/src/newsroom`)).filter(f=>f.endsWith('.js')).sort();
const hashes = {};
for (const f of [...files.map(f=>`src/newsroom/${f}`), 'scripts/newsroom-publisher.mjs']) hashes[f] = crypto.createHash('sha256').update(await fs.readFile(`${root}/${f}`)).digest('hex');
await fs.writeFile(`${out}/provenance.json`, JSON.stringify({skillVersion:skill.version,sha256:hashes},null,2)+'\n');
const requests={};
const provider={name:'capture',strictSchema:true,models:{},generate:async req=>{requests[req.pass]=req;return {ok:false,reason:'unavailable'};}};
await claude.draftArticle({pack:{},hints:{},validTemplates:[],provider,skill});
await claude.editArticle({pack:{},draft:{template:'breaking',headline:'',dek:'',articleType:'BREAKING',section:'sets',blocks:[]},provider,skill});
for (const pass of ['reporter','editor']) await fs.writeFile(`${out}/${pass}-request.json`,JSON.stringify(JSON.parse(requests[pass].user),null,2)+'\n');
