import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PaperStore } from '../lib/paper-store.mjs';
import { probeText,probePlacesRun,inProbeArea,PROBE_AREA } from '../lib/paper-probe.mjs';
import { riskLabels,cluesWithoutAreaResult } from '../lib/paper-risk.mjs';
import { shorterQueries,withShorterQueries,MAX_SHORTER_QUERIES } from '../lib/paper-runner.mjs';

const at=(latitude,longitude)=>({latitude,longitude,title:'t',category:'c'});
const seoul=at(37.55,126.98),busan=at(35.18,129.08);

test('a probe counts results in all and in the area, and stores no coordinate',async()=>{
  assert.equal(inProbeArea(seoul),true);assert.equal(inProbeArea(busan),false);
  const probe=await probeText({query:'x',search:async()=>({status:'resolved',places:[seoul,busan,busan]})});
  assert.deepEqual([probe.query,probe.status,probe.area,probe.resultCount,probe.inAreaCount],['x','resolved',PROBE_AREA.name,3,1]);
  assert.ok(!/latitude|longitude|37\.55/.test(JSON.stringify(probe)));
  const empty=await probeText({query:'y',search:async()=>({status:'no_result',places:[]})});
  assert.deepEqual([empty.resultCount,empty.inAreaCount],[0,0]);
  assert.deepEqual(await probeText({query:'z',search:async()=>({status:'http_401'})}),{blocked:true,status:'http_401'});
});

test('a record is probed without any true position, once',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-probe-'));
  try{
    const store=new PaperStore(directory);
    const run=store.createRun({width:10,height:10,sha256:'a'},Buffer.from('i'),{});
    run.status='classified';
    run.clues=[{id:'clue-0',category:'Sign',detail:'d',textTargets:['동네가게','체인'],regions:[{kind:'text'}]},{id:'clue-1',category:'Tree',detail:'d',textTargets:[],regions:[]}];
    store.saveRun(run);
    const asked=[];
    const search=async query=>{asked.push(query);return query==='동네가게'?{status:'resolved',places:[seoul]}:{status:'resolved',places:[busan]};};
    const first=await probePlacesRun({store,run:store.getRun(run.id),search});
    assert.deepEqual(first.run.placeProbes.map(probe=>[probe.query,probe.inAreaCount,probe.clueIds]),[['동네가게',1,['clue-0']],['체인',0,['clue-0']]]);
    await probePlacesRun({store,run:store.getRun(run.id),search});
    assert.equal(asked.length,2);   // not searched again without force
    const blocked=await probePlacesRun({store,run:store.getRun(run.id),search:async()=>({status:'key_missing'}),force:true});
    assert.equal(blocked.blocked,'key_missing');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a tier A clue whose texts find nothing in the area is shown as low; a search hit still wins',()=>{
  const clue=(id,name,regions)=>({id,category:'c',detail:'d',taxonomy:{number:1,name},regions});
  const run={clues:[
    clue('clue-0','Commercial Signage',[{kind:'text'}]),   // both of its texts find nothing in the area
    clue('clue-1','Commercial Signage',[{kind:'text'}]),   // one of its texts finds something
    clue('clue-2','Community Features',[{kind:'object'}]), // no quoted text: nothing was searched
    clue('clue-3','Commercial Signage',[{kind:'text'}]),   // nothing in the area by count, but its search led to the place
  ],
  placeProbes:[
    {query:'a',clueIds:['clue-0'],resultCount:3,inAreaCount:0},{query:'b',clueIds:['clue-0'],resultCount:0,inAreaCount:0},
    {query:'c',clueIds:['clue-1'],resultCount:0,inAreaCount:0},{query:'d',clueIds:['clue-1'],resultCount:5,inAreaCount:2},
    {query:'e',clueIds:['clue-3'],resultCount:0,inAreaCount:0}],
  placeSearches:[{query:'e',clueIds:['clue-3'],topWithinRadius:true,topDistanceM:12}]};
  assert.deepEqual([...cluesWithoutAreaResult(run)].sort(),['clue-0','clue-3']);
  const labels=riskLabels(run);
  assert.deepEqual(Object.values(labels.clues).map(entry=>entry.label),['low','potential','potential','confirmed']);
  assert.match(labels.clues['clue-0'].reason,/지도에서 검색해도 이 지역에 나오는 곳이 없음/);
  assert.equal(labels.probed,true);
  // Without probes nothing is lowered.
  assert.deepEqual(Object.values(riskLabels({clues:run.clues}).clues).map(entry=>entry.label),['potential','potential','potential','potential']);
});

test('a quoted sentence that finds nothing is typed again in shorter forms',async()=>{
  const wall='서울시립 서서울미술관 미디어 작가전 / Seo-Seoul Museum of Art Solo Exhibition of Media Artist';
  const shorter=shorterQueries(wall,99);
  // The parts between separators first, then each part with words dropped from the end, never below two words.
  assert.deepEqual(shorter.slice(0,4),['서울시립 서서울미술관 미디어 작가전','Seo-Seoul Museum of Art Solo Exhibition of Media Artist','서울시립 서서울미술관 미디어','서울시립 서서울미술관']);
  assert.ok(shorter.includes('Seo-Seoul Museum of Art')&&!shorter.includes('서울시립')&&!shorter.includes(wall));
  assert.equal(shorterQueries(wall).length,MAX_SHORTER_QUERIES);
  assert.deepEqual(shorterQueries('김희천: 두더지들'),['김희천','두더지들']);
  assert.deepEqual(shorterQueries('CAU'),[]);
  assert.deepEqual(shorterQueries('재팔이네 닭발'),[]);          // two words: nothing shorter worth typing
  assert.deepEqual(shorterQueries('혜당 한방 병원'),['혜당 한방']);
  // The first form that finds something is the answer, marked with what was typed.
  const asked=[];
  const attempt=async query=>{asked.push(query);return query==='서울시립 서서울미술관'?{query,status:'resolved',inAreaCount:1}:{query,status:'no_result',inAreaCount:0};};
  const found=await withShorterQueries(wall,attempt);
  assert.deepEqual([found.query,found.searchedAs,found.status,found.shorterTried],[wall,'서울시립 서서울미술관','resolved',4]);
  assert.equal(asked.length,5);
  // A text that finds something at once is not typed again; one that never does keeps its empty result.
  asked.length=0;
  assert.equal((await withShorterQueries('서울시립 서서울미술관',attempt)).searchedAs,undefined);
  assert.equal(asked.length,1);
  const none=await withShorterQueries('아무 데도 없는 긴 문장입니다',attempt);
  assert.deepEqual([none.status,none.searchedAs,none.shorterTried],['no_result',undefined,3]);
  // A refused key stops at once.
  assert.deepEqual(await withShorterQueries(wall,async()=>({blocked:true,status:'http_401'})),{blocked:true,status:'http_401'});
  // The label says which form was typed.
  const labels=riskLabels({clues:[{id:'clue-0',category:'c',detail:'d',taxonomy:{number:1,name:'Event Announcement Displays'},regions:[]}],
    placeSearches:[{query:wall,searchedAs:'서울시립 서서울미술관',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:40}]});
  assert.match(labels.clues['clue-0'].evidence[0],/지도 검색 "서울시립 서서울미술관" \(인용문을 줄여서 검색\) → 첫 결과가 실제 위치 \(40m\)/);
});
