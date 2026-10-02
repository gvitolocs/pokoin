// Durable, credential-free scanner diagnostics, acknowledged by authenticated heartbeat.
(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.ScanDiagnostics=api;
})(typeof self!=='undefined'?self:this,function() {
  'use strict';
  const VERSION='scan-diag-v2';
  const KEY='pokoin.scanDiagnostics.v2';
  function create({storage,sessionId,now=Date.now,uuid}={}) {
    let saved;
    try {saved=JSON.parse(storage.getItem(KEY)||'null');}catch(_){}
    const valid=saved && saved.sessionId===sessionId && saved.version===VERSION;
    const runId=valid?saved.runId:uuid();
    let sequence=valid?saved.sequence:0;
    let entries=valid && Array.isArray(saved.entries)?saved.entries.slice(-2048):[];
    const persist=()=>{try{storage.setItem(KEY,JSON.stringify({version:VERSION,sessionId,runId,sequence,entries}));}catch(_){}};
    return {
      record(kind,fields={}) {
        // Callers supply only bounded metadata. Never pass blobs or request bodies.
        entries.push({...fields,kind,at:now(),sequence:++sequence,clientVersion:VERSION});
        if(entries.length>2048) entries.shift();
      },
      packet(){persist();return {version:VERSION,runId,entries:entries.slice(0,32)};},
      acknowledge(ids){
        const acknowledged=new Set(Array.isArray(ids)?ids:[]);
        entries=entries.filter(row=>!acknowledged.has(row.sequence));persist();
      },
      persist,
      get pending(){return entries.length;},
    };
  }
  return {VERSION,KEY,create};
});
