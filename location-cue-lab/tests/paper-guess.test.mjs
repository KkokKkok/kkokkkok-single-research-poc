import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuessMatch,guessMatchPrompt,needsGuessMatch,matchGuessClues,guessUsedClues,guessSoloPrompt,parseGuessSolo,testGuessSolo } from '../lib/paper-guess.mjs';
import { guessCombination,guessSoloTargets,ruleMarks,usedClueIds,RAISED_NOTE } from '../lib/paper-rules.mjs';
import { viewerData } from '../lib/paper-viewer.mjs';
import { toInspection } from '../lib/paper-inspection.mjs';
import { pointTargets } from '../lib/paper-point.mjs';

const fence=value=>'생각...\n```json\n'+JSON.stringify(value)+'\n```';
const clue=(id,detail,rule)=>({id,category:'c',detail,taxonomy:null,...(rule?{rule}:{})});
const rule=(cls,unit,risk)=>({class:cls,situation:'s',basis:'b',unit,risk});
const prediction=(fields={})=>({createdAt:'2026-11-17T00:00:00.000Z',model:'m',topN:1,status:'answered',addressList:['a'],
  clueList:["Statue of a dragon holding a globe","Korean text on signs","Autumn trees"],score:{status:'scored',distanceM:120},...fields});
const run=(fields={})=>({id:'r',status:'extracted',errors:[],image:{width:10,height:10},
  clues:[clue('clue-0','Bronze dragon around a globe',rule('structure','few','medium')),clue('clue-1','Hangul on signs',rule('regional','country','low')),
    clue('clue-2','Maples in autumn colour',rule('nature','city','low')),clue('clue-3','Paved road',rule('other','city','low'))],
  rules:{version:'v',combinations:[]},predictions:[prediction()],...fields});
const matched=(matches,createdAt='2026-11-17T00:00:00.000Z')=>({prediction:{createdAt},matches:matches.map((clueIds,index)=>({index,text:`t${index}`,clueIds}))});

test('the matching answer must name every guess clue and only known clues',()=>{
  const ids=['clue-0','clue-1'];
  assert.deepEqual(parseGuessMatch(fence({'guess-0':['clue-0','clue-0'],'guess-1':[]}),2,ids),[['clue-0'],[]]);
  assert.throws(()=>parseGuessMatch(fence({'guess-0':['clue-0']}),2,ids),/GUESS_MATCH_INCOMPLETE/);
  assert.throws(()=>parseGuessMatch(fence({'guess-0':['clue-9'],'guess-1':[]}),2,ids),/GUESS_MATCH_UNKNOWN_CLUE/);
  assert.throws(()=>parseGuessMatch('nothing',2,ids),/GUESS_MATCH_INVALID/);
  const prompt=guessMatchPrompt(['A sign'],[clue('clue-0','The sign')]);
  assert.match(prompt,/guess-0: A sign/);assert.match(prompt,/clue-0: The sign/);
});

test('only a guess that found the place is matched, once per prediction',()=>{
  assert.equal(needsGuessMatch(run()),true);
  assert.equal(needsGuessMatch(run({predictions:[prediction({score:{status:'scored',distanceM:4000}})]})),false);
  assert.equal(needsGuessMatch(run({predictions:[prediction({clueList:[]})]})),false);
  assert.equal(needsGuessMatch(run({guessClues:matched([[],[],[]])})),false);
  assert.equal(needsGuessMatch(run({guessClues:matched([[],[],[]])}),{force:true}),true);
  // A newer guess makes the earlier matching stale.
  assert.equal(needsGuessMatch(run({guessClues:matched([[],[],[]],'2026-11-01T00:00:00.000Z')})),true);
});

test('matchGuessClues asks once more after a bad answer and records the prediction it belongs to',async()=>{
  const answers=['no json',fence({'guess-0':['clue-0'],'guess-1':['clue-1'],'guess-2':['clue-2']})],calls=[];
  const llm=async({attempt})=>({text:answers[attempt-1],raw:{}});
  const result=await matchGuessClues({run:run(),model:'x',llm,onCall:call=>calls.push(call)});
  assert.equal(result.attempts,2);assert.equal(calls.length,2);assert.equal(calls[0].stage,'guessMatch');
  assert.equal(result.prediction.createdAt,'2026-11-17T00:00:00.000Z');
  assert.deepEqual(result.matches.map(item=>item.clueIds),[['clue-0'],['clue-1'],['clue-2']]);
});

test('the clues a hit guess used become a high combination that is covered',()=>{
  const record=run({guessClues:matched([['clue-0'],['clue-1'],['clue-2']])});
  assert.deepEqual(guessUsedClues(record).clueIds,['clue-0','clue-1','clue-2']);
  const combo=guessCombination(record);
  // Hangul (country) is in every photo of the country: covering it hides nothing.
  assert.deepEqual(combo.clueIds,['clue-0','clue-2']);assert.deepEqual(combo.excluded,['clue-1']);
  assert.equal(combo.risk,'high');assert.equal(combo.type,'guess');
  assert.deepEqual(ruleMarks(record).combinations.map(item=>item.id),['guess']);
  assert.deepEqual([...usedClueIds(record)].sort(),['clue-0','clue-2']);
  // No region yet: both are asked about by the pointing step.
  assert.deepEqual(pointTargets(record).map(item=>item.id),['clue-0','clue-2']);
  const inspection=toInspection(record,{status:'completed'});
  assert.deepEqual(inspection.combinations.find(item=>item.type==='guess').clueIds,['clue-0','clue-2']);
  assert.equal(inspection.riskSummary.level,'high');
});

test('a guess that missed, was rescored, or belongs to an older prediction gives no combination',()=>{
  const used=matched([['clue-0'],[],[]]);
  assert.equal(guessCombination(run({guessClues:used,predictions:[prediction({score:{status:'scored',distanceM:4000}})]})),null);
  assert.equal(guessCombination(run({guessClues:matched([['clue-0'],[],[]],'2026-11-01T00:00:00.000Z')})),null);
  assert.equal(guessCombination(run()),null);
  // Only country-level clues matched: nothing coverable is left.
  assert.equal(guessCombination(run({guessClues:matched([[],['clue-1'],[]])})),null);
  assert.deepEqual(usedClueIds(run()).size,0);
});

const solo=(entries,createdAt='2026-11-17T00:00:00.000Z')=>({prediction:{createdAt},clues:Object.entries(entries).map(([clueId,hit])=>({clueId,kind:'observation',address:hit?'a':null,geocodeStatus:hit?'resolved':null,distanceM:hit?40:null,hit}))});
const withSign=fields=>run({clues:[...run().clues,clue('clue-4','Station sign reads "합정"',rule('identifier','point','high'))],guessClues:matched([['clue-0','clue-4'],['clue-1'],['clue-2']]),...fields});

test('only the clues that give the place away by themselves are raised; the others keep their risk',()=>{
  // The sign is a point by the sheet, the dragon led to the place when tried alone, the maples did not.
  const record=withSign({guessSolo:solo({'clue-0':true,'clue-2':false})});
  const combo=guessCombination(record);
  assert.equal(combo.mode,'solo');
  assert.deepEqual(combo.clueIds,['clue-0','clue-4']);assert.deepEqual(combo.supporting,['clue-2']);
  assert.deepEqual(combo.soloBy,{'clue-0':'alone','clue-4':'rule'});
  const marks=ruleMarks(record);
  assert.deepEqual(Object.values(marks.clues).map(item=>item.risk),['high','low','low','low','high']);
  assert.deepEqual(marks.clues['clue-0'].raised,{from:'medium',by:'address_guess_alone'});
  // Already high: not raised. A supporting clue, a country-level one and an unused one: unchanged.
  for(const id of ['clue-1','clue-2','clue-3','clue-4'])assert.equal(marks.clues[id].raised,undefined);
  assert.deepEqual(marks.counts,{high:2,medium:0,low:3});
  assert.deepEqual([...usedClueIds(record)].sort(),['clue-0','clue-4']);
  const factors=toInspection(record,{status:'completed'}).riskFactors;
  assert.deepEqual(factors.map(item=>item.modelRisk),['high','low','low','low','high']);
  assert.equal(factors[0].description,`Bronze dragon around a globe ${RAISED_NOTE}`);
  assert.equal(factors[2].description,'Maples in autumn colour');assert.equal(factors[4].description,'Station sign reads "합정"');
  const photo=viewerData([{run:record,korean:{'clue-0':'지구본을 감은 청동 용'},title:'t'}]).photos[0];
  assert.equal(photo.clues[0].ko,`지구본을 감은 청동 용 ${RAISED_NOTE}`);assert.equal(photo.clues[0].en,`Bronze dragon around a globe ${RAISED_NOTE}`);
  assert.equal(photo.clues[2].en,'Maples in autumn colour');
  assert.deepEqual([photo.combinations[0].clueNs,photo.combinations[0].supportingNs],[[1,5],[3]]);
  // Several clues can each do it alone: all of them are raised.
  const both=ruleMarks(withSign({guessSolo:solo({'clue-0':true,'clue-2':true})}));
  assert.deepEqual(Object.values(both.clues).map(item=>item.risk),['high','low','high','low','high']);
  // The sheet's point alone decides when the test was not run: nothing else is raised.
  const untested=withSign();
  assert.equal(guessCombination(untested).mode,'solo');
  assert.deepEqual(Object.values(ruleMarks(untested).clues).map(item=>item.risk),['medium','low','low','low','high']);
  // A map search that led to the true place makes a clue a risk by itself, without the test.
  const searched=run({guessClues:matched([['clue-0'],[],['clue-2']]),placeSearches:[{query:'x',topWithinRadius:true,topDistanceM:30,clueIds:['clue-2']}]});
  assert.deepEqual(guessCombination(searched).soloBy,{'clue-2':'search'});
  assert.deepEqual(ruleMarks(searched).clues['clue-2'].raised,{from:'low',by:'address_guess_search'});
  assert.equal(ruleMarks(searched).clues['clue-0'].risk,'medium');
});

test('when no clue does it alone, the clues together are raised; before the test, none is',()=>{
  const used=matched([['clue-0'],['clue-1'],['clue-2']]);
  const together=run({guessClues:used,guessSolo:solo({'clue-0':false,'clue-2':false})});
  assert.equal(guessCombination(together).mode,'combined');
  const marks=ruleMarks(together);
  assert.deepEqual(Object.values(marks.clues).map(item=>item.risk),['high','low','high','low']);
  assert.deepEqual(marks.clues['clue-2'].raised,{from:'low',by:'address_guess_combined'});
  assert.equal(toInspection(together,{status:'completed'}).riskFactors[2].description,`Maples in autumn colour ${RAISED_NOTE}`);
  // Not tried alone yet: the combination is listed, no clue is raised.
  const untested=run({guessClues:used});
  assert.equal(guessCombination(untested).mode,'untested');
  assert.deepEqual(Object.values(ruleMarks(untested).clues).map(item=>item.risk),['medium','low','low','low']);
  // A test that left a clue out, or that belongs to an older guess, does not count as "none does it alone".
  assert.equal(guessCombination(run({guessClues:used,guessSolo:solo({'clue-0':false})})).mode,'untested');
  assert.equal(guessCombination(run({guessClues:used,guessSolo:solo({'clue-0':false,'clue-2':false},'2026-11-01T00:00:00.000Z')})).mode,'untested');
  assert.deepEqual(guessSoloTargets(untested).map(item=>item.id),['clue-0','clue-2']);
  assert.deepEqual(guessSoloTargets(withSign()).map(item=>item.id),['clue-0','clue-2']);
  // A guess that missed raises nothing.
  const missed=ruleMarks(run({guessClues:used,guessSolo:together.guessSolo,predictions:[prediction({score:{status:'scored',distanceM:4000}})]}));
  assert.deepEqual(Object.values(missed.clues).map(item=>item.risk),['medium','low','low','low']);
});

test('each clue is tried alone against the place the guess found',async()=>{
  const targets=run().clues.filter(item=>['clue-0','clue-2','clue-3'].includes(item.id));
  assert.match(guessSoloPrompt(targets),/clue-0: Bronze dragon around a globe\nclue-2: /);
  const answer=fence({'clue-0':{kind:'observation',address:'dragon st'},'clue-2':{kind:'observation',address:null},'clue-3':{kind:'conclusion',address:'somewhere'}});
  assert.deepEqual(parseGuessSolo(answer,['clue-0','clue-2','clue-3']),{'clue-0':{kind:'observation',address:'dragon st'},'clue-2':{kind:'observation',address:null},'clue-3':{kind:'conclusion',address:null}});
  assert.throws(()=>parseGuessSolo(fence({'clue-0':{kind:'observation',address:'x'}}),['clue-0','clue-2']),/GUESS_SOLO_INCOMPLETE/);
  assert.throws(()=>parseGuessSolo('nothing',['clue-0']),/GUESS_SOLO_INVALID/);
  const places={a:{status:'resolved',latitude:0,longitude:0},'dragon st':{status:'resolved',latitude:0,longitude:0.001},'far st':{status:'resolved',latitude:1,longitude:1}};
  const geocode=async address=>places[address]??{status:'no_result'},distance=(from,to)=>Math.hypot(from.latitude-to.latitude,from.longitude-to.longitude)*100000;
  const llm=async()=>({text:answer,raw:{}});
  const {solo:result}=await testGuessSolo({run:run(),targets,model:'x',llm,geocode,geocoder:'fake',distance});
  assert.deepEqual(result.clues.map(item=>[item.clueId,item.kind,item.hit]),[['clue-0','observation',true],['clue-2','observation',false],['clue-3','conclusion',false]]);
  assert.equal(result.prediction.createdAt,'2026-11-17T00:00:00.000Z');assert.equal(result.radiusM,500);
  // An address elsewhere is no hit; a geocoder that cannot be used stops the test without a result.
  const far=await testGuessSolo({run:run(),targets:[targets[0]],model:'x',llm:async()=>({text:fence({'clue-0':{kind:'observation',address:'far st'}}),raw:{}}),geocode,geocoder:'fake',distance});
  assert.equal(far.solo.clues[0].hit,false);
  assert.deepEqual(await testGuessSolo({run:run(),targets,model:'x',llm,geocode:async()=>({status:'key_missing'}),geocoder:'fake',distance,blocking:status=>status==='key_missing'}),{blocked:'key_missing'});
  // Nothing to try (every member is already a point): an empty result, and no model call.
  assert.deepEqual((await testGuessSolo({run:run(),targets:[],model:'x',llm:async()=>{throw new Error('called');},geocode,geocoder:'fake',distance})).solo.clues,[]);
});
