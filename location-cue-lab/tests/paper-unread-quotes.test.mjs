import test from 'node:test';
import assert from 'node:assert/strict';
import { relinkUnreadQuotes,quotesNotInPhoto } from '../lib/paper-regions.mjs';
import { TIERED_POLICY } from '../lib/paper-risk-tiers.mjs';
import { trustedRegions,hasQuotedText } from '../lib/paper-risk.mjs';
import { mainRegion,factorType } from '../lib/paper-inspection.mjs';

const fence='```';
const targetsAnswer=`${fence}json\n${JSON.stringify({'clue-0':['shop sign'],'clue-1':['light-blue plush dragon','orange dragon horns','third phrase'],'clue-2':['tree'],'clue-3':['emblem']})}\n${fence}`;
// As the records are after linking and the text recheck.
const clues=()=>[
  // Text OCR read: stays a text clue.
  {id:'clue-0',detail:'Sign reads "CAFE ONE"',textTargets:['CAFE ONE'],objectTargets:[],regions:[{id:'t',kind:'text',source:'paddleocr',bbox:[0.1,0.1,0.3,0.2],quoted:'CAFE ONE',score:0.9}],localization:'proposed'},
  // A recognised name in quotes: no OCR line, and the model found no place for it.
  {id:'clue-1',detail:"Plush dragon matching 'Puang', a mascot",textTargets:['Puang'],objectTargets:[],regions:[],localization:'unlocalized',rule:{class:'other',unit:'few',risk:'medium'}},
  {id:'clue-2',detail:'A tree',textTargets:[],objectTargets:[],regions:[],localization:'not_searched'},
  // Quoted text OCR missed but the model pointed at: located as text, left alone.
  {id:'clue-3',detail:'Emblem "100"',textTargets:['100'],objectTargets:[],regions:[{id:'h',kind:'text',source:'model_hint',bbox:[0,0.5,0.1,0.6],quoted:'100',verified:false}],localization:'proposed'}];
const detector=calls=>async(bytes,queries)=>{calls.push(queries.map(query=>query.query));return {engine:'Grounding DINO',model:'fixture',revision:'r',requests:queries.map(query=>({cueId:query.cueId,query:query.query,
  detections:query.query==='orange dragon horns'?[{id:`${query.cueId}-big`,bbox:[0,0,1,0.9],score:0.9,label:query.query}]:[{id:`${query.cueId}-0`,bbox:[0,0.6,0.5,1],score:0.7,label:query.query}]}))};};

test('a clue whose quoted name is written nowhere in the photo is looked for as an object',async()=>{
  const list=clues(),calls=[];
  assert.deepEqual(list.filter(quotesNotInPhoto).map(clue=>clue.id),['clue-1']);
  const summary=await relinkUnreadQuotes({bytes:Buffer.from('i'),clues:list,targetsAnswer,detect:detector(calls),policy:TIERED_POLICY,tierOf:()=>'A'});
  // Only that clue's phrases are sent, at most two a clue as the policy says.
  assert.deepEqual(calls,[['light-blue plush dragon','orange dragon horns']]);
  assert.deepEqual(summary,{clues:['clue-1'],queryCount:2,located:1,droppedLargeBoxes:1});
  const toy=list[1];
  assert.deepEqual([toy.textTargets,toy.unreadQuotes,toy.objectTargets,toy.localization],[[],['Puang'],['light-blue plush dragon','orange dragon horns'],'proposed']);
  assert.deepEqual(toy.regions.map(region=>[region.kind,region.source,region.bbox]),[['object','grounding_dino',[0,0.6,0.5,1]]]);
  // It now counts as an object clue everywhere a region is trusted, shown or typed.
  assert.equal(hasQuotedText(toy),false);
  assert.equal(trustedRegions(toy).length,1);
  assert.deepEqual(mainRegion(toy).bbox,[0,0.6,0.5,1]);
  assert.equal(factorType(toy),'object');
  // The others are as they were.
  assert.deepEqual(list.map(clue=>clue.textTargets.length),[1,0,0,1]);
  assert.equal(list[0].regions.length+list[3].regions.length,2);
});

test('a low clue is demoted but not searched, and nothing is asked when no clue is affected',async()=>{
  const list=clues(),calls=[];
  const summary=await relinkUnreadQuotes({bytes:Buffer.from('i'),clues:list,targetsAnswer,detect:detector(calls),policy:TIERED_POLICY,tierOf:()=>'B'});
  assert.deepEqual(calls,[]);
  assert.deepEqual(summary,{clues:['clue-1'],queryCount:0,located:0,droppedLargeBoxes:0});
  assert.deepEqual([list[1].textTargets,list[1].unreadQuotes,list[1].regions],[[],['Puang'],[]]);
  // Run again: the clue no longer quotes text, so there is nothing to do.
  assert.deepEqual(await relinkUnreadQuotes({bytes:Buffer.from('i'),clues:list,targetsAnswer,detect:detector(calls)}),{clues:[],queryCount:0,located:0,droppedLargeBoxes:0});
  // An unreadable target answer leaves the clue demoted without a search.
  const again=clues();
  assert.equal((await relinkUnreadQuotes({bytes:Buffer.from('i'),clues:again,targetsAnswer:'no json',detect:detector(calls)})).queryCount,0);
  assert.deepEqual(calls,[]);
});
