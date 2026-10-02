const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const path=require('node:path');
const esbuild=require('../node_modules/esbuild');
const {chromium}=require('/home/nez/Projects/pokemon-card-extension/node_modules/playwright-core');

test('flat positions render one box list; explicit divider positions still render stacks',async()=>{
 const root=path.resolve(__dirname,'..');
 const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter} from 'react-router-dom';import LocationBoard from './src/components/LocationBoard.jsx';
 const flat=Array.from({length:8},(_,n)=>({id:String(n+1),cardId:'633460',cardName:'Card '+(n+1),location:'box·'+(n===7?'8-9':n+1),quantityAvailable:n===7?2:1}));
 const rows=location.search?'dividers':null;
 createRoot(document.getElementById('app')).render(<MemoryRouter><LocationBoard rows={rows?flat.map((r,n)=>({...r,location:'box·1·'+(n+1)})):flat} location="box" formatPrice={()=>'42 PKN'}/></MemoryRouter>);`;
 const build=await esbuild.build({stdin:{contents:source,resolveDir:root,loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
 const server=http.createServer((req,res)=>{if(req.url.startsWith('/bundle.js')){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(build.outputFiles[0].text);}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<div id="app"></div><script src="/bundle.js"></script>');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();const base='http://127.0.0.1:'+server.address().port;
  page.on('pageerror',error=>console.error(error.message));
  await page.goto(base);await page.waitForSelector('.loc-posting');
  assert.equal(await page.locator('.loc-stack').count(),1);
  assert.equal(await page.locator('.loc-posting').count(),8);
  assert.equal(await page.locator('.loc-stack-no').textContent(),'Cards in the box');
  assert.equal(await page.locator('.inv-stat').count(),2);
  assert.match(await page.locator('.inv-summary').textContent(),/8Postings9Copies/);
  assert.match(await page.locator('.loc-posting').last().textContent(),/pos 8-9/);
  await page.goto(base+'?dividers');await page.waitForSelector('.loc-posting');
  assert.equal(await page.locator('.loc-stack-no').textContent(),'Stack 1');
  assert.equal(await page.locator('.inv-stat').count(),3);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
});
