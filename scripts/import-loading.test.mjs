import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const app = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const sourceLoader = app.slice(app.indexOf('async function setSource('), app.indexOf('\nasync function getDecodedAudio'));
function harness(fetch, {quotaError=false} = {}) {
  const calls = {saves:0,analysis:0};
  const element = () => ({classList:{add(){},remove(){}},pause(){},load(){},scrollIntoView(){},focus(){}});
  const context = vm.createContext({
    state:{}, ui:{audio:element(),sourceName:element(),empty:element(),stage:element()},
    $:element, window:{matchMedia:()=>({matches:true})}, console, URL, AbortSignal,
    cancelPracticePlayback(){},markActiveSource(){},resetLesson(){},renderActiveClip(){},
    updateAutoAnalyzeUI(){},toast(){},escapeHtml:s=>s,getCacheKey:s=>s,
    document:{querySelectorAll:()=>[]},
    isPreparedClip: c => Boolean(c && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)) && c.end > c.start && c.japanese?.trim() && c.rubyText?.trim() && c.translation?.trim()),
    hasPreparedTranscript: clips => Array.isArray(clips) && clips.length > 0 && clips.every(c => Boolean(c && Number.isFinite(Number(c.start)) && Number.isFinite(Number(c.end)) && c.end > c.start && c.japanese?.trim() && c.rubyText?.trim() && c.translation?.trim())),
    localStorage:{setItem(){if(quotaError) throw Error('quota');}},
    loadClipCache:()=>[{japanese:'stale',analyzed:true}],repairClips:x=>x,
    saveClipCache(){calls.saves++;},startAutoAnalyze(){calls.analysis++;},fetch
  });
  vm.runInContext(sourceLoader,context);
  return {context,calls};
}
const imported={protectedImport:true,clips:[{japanese:'imported',analyzed:true}]};
test('static import replaces stale cache without autosave or AI requests',async()=>{
  const {context,calls}=harness(async()=>({ok:true,json:async()=>imported}));
  await context.setSource({name:'episode.mp3',url:'/audio/episode.mp3'});
  assert.equal(context.state.clips[0].japanese,'imported');
  assert.equal(calls.saves,0);assert.equal(calls.analysis,0);
});
test('database override works when no static import exists',async()=>{
  const {context}=harness(async url=>url.includes('/overrides/')?{ok:false}:{ok:true,json:async()=>({data:imported})});
  await context.setSource({name:'episode.mp3',url:'/audio/episode.mp3'});
  assert.equal(context.state.clips[0].japanese,'imported');
});
test('storage quota failure cannot replace a loaded import with stale cache',async()=>{
  const {context}=harness(async()=>({ok:true,json:async()=>imported}),{quotaError:true});
  await context.setSource({name:'episode.mp3',url:'/audio/episode.mp3'});
  assert.equal(context.state.clips[0].japanese,'imported');
});
test('unimported audio retains the existing cache workflow',async()=>{
  const {context,calls}=harness(async()=>({ok:false}));
  await context.setSource({name:'new.mp3',url:'/audio/new.mp3'});
  assert.equal(context.state.clips[0].japanese,'stale');assert.equal(calls.saves,1);
});
test('a delayed import cannot replace a newly selected source',async()=>{
  let resolve;
  const pending=new Promise(r=>{resolve=r;});
  const {context}=harness(async()=>pending);
  const loading=context.setSource({name:'old.mp3',url:'/old'});
  context.state.source={name:'new.mp3',url:'/new'};
  resolve({ok:true,json:async()=>imported});
  await loading;
  assert.equal(context.state.clips,undefined);
});
