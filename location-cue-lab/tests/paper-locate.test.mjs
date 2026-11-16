import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { COT_LOCATION_TEMPLATE,cotLocationPrompt,PROMPT_SOURCES } from '../lib/paper-prompts.mjs';
import { extractLists,parseStringList,predictLocation } from '../lib/paper-pipeline.mjs';
import { locatorStage } from '../lib/paper-llm.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { handoffLlm,pendingHandoffs } from '../lib/paper-handoff.mjs';
import { locateRun,miningCorpus } from '../lib/paper-runner.mjs';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const fence='```';
const cotAnswer=(clues,addresses)=>`Thinking it through.\n\nclue_list:\n${fence}list\n${JSON.stringify(clues,null,1)}\n${fence}\n\naddress_list:\n${fence}list\n${JSON.stringify(addresses)}\n${fence}\n`;

test('the address-prediction prompt is byte-identical to experiment.py and marked evaluation-only',()=>{
  // sha256 of get_standard_prompt() with cot_mode "on": the template, and Python's rendering for Top-1 and Top-3.
  assert.equal(sha256(COT_LOCATION_TEMPLATE),'a038911a764f4867ea52ee50e996cb20c896b4cb3186d03265805e6a19dd462f');
  assert.equal(sha256(cotLocationPrompt()),'43ccd7c3e06b9cdca31b1962a09b5093c7be085b40343fe23af498943605b46c');
  assert.equal(sha256(cotLocationPrompt(3)),'1585adf01b301c33eb016aae1b6632b56af686fe201ab979d4d700a905858225');
  assert.ok(cotLocationPrompt().startsWith('where is it?\n\n1. list all the clues you have used for prediction:'));
  assert.deepEqual([PROMPT_SOURCES.cotLocation.verbatim,PROMPT_SOURCES.cotLocation.evaluationOnly,PROMPT_SOURCES.cotLocation.license],[true,true,'Apache-2.0']);
});

test('clue and address lists are read with the repository patterns',()=>{
  const lists=extractLists(cotAnswer(['Sign reads "A"','Palm trees'],['1 Main St, Springfield, IL 62701']));
  assert.deepEqual(parseStringList(lists.clueListRaw),['Sign reads "A"','Palm trees']);
  assert.deepEqual(parseStringList(lists.addressListRaw),['1 Main St, Springfield, IL 62701']);
  assert.deepEqual(extractLists(`CLUE_LIST:\n${fence}list\n["a"]\n${fence}`),{clueListRaw:'["a"]',addressListRaw:''});
  assert.deepEqual(extractLists('I cannot determine the location.'),{clueListRaw:'',addressListRaw:''});assert.deepEqual(extractLists(null),{clueListRaw:'',addressListRaw:''});
  // The prompt's own placeholder, echoed back, is not a list of strings; neither are single quotes.
  assert.equal(parseStringList('["", "", "", ......]'),null);assert.equal(parseStringList("['a']"),null);assert.equal(parseStringList(''),null);assert.equal(parseStringList('[1]'),null);
  assert.deepEqual(parseStringList('[" a ", ""]'),['a']);
});

test('predictLocation sends the verbatim prompt with the image, once',async()=>{
  const calls=[],recorded=[];const bytes=Buffer.from('photo');
  const llm=async call=>{calls.push(call);return {text:cotAnswer(['clue'],['addr']),raw:{responseId:'r'}};};
  const result=await predictLocation({bytes,model:'m',reasoningEffort:'medium',llm,onCall:call=>recorded.push(call)});
  assert.deepEqual(calls.map(c=>[c.model,c.reasoningEffort,c.text===cotLocationPrompt(1),c.imageBytes===bytes,c.attempt]),[['m','medium',true,true,1]]);
  assert.deepEqual([result.topN,result.clueList,result.addressList],[1,['clue'],['addr']]);assert.deepEqual(recorded.map(c=>c.stage),['locator']);
  const refusal=await predictLocation({bytes,model:'m',llm:async()=>({text:'Sorry, I cannot help with that.',raw:{}}),topN:3});
  assert.deepEqual([refusal.topN,refusal.clueList,refusal.addressList,refusal.answer],[3,null,null,'Sorry, I cannot help with that.']);
});

test('locator stage runs on the current model and knows the paper\'s three',()=>{
  const current=locatorStage({OPENAI_MODEL:'gpt-5.4-mini'});
  assert.deepEqual([current.model,current.reasoningEffort,current.transport,current.matchesPaper],['gpt-5.4-mini',null,'openai-responses',false]);
  assert.ok(current.paperModel.includes('o3-2025-04-16')&&current.paperModel.includes('gpt-4.1-2025-04-14'));
  assert.equal(locatorStage({PAPER_LOCATOR_MODEL:'o3-2025-04-16',PAPER_LOCATOR_REASONING_EFFORT:'medium'}).matchesPaper,true);
  assert.equal(locatorStage({PAPER_LOCATOR_MODEL:'o3-2025-04-16'}).matchesPaper,false);
  assert.equal(locatorStage({PAPER_LOCATOR_MODEL:'gpt-4.1-2025-04-14'}).matchesPaper,true);
  assert.deepEqual([locatorStage({}).model,locatorStage({},{handoffModel:'stand-in'}).model,locatorStage({},{handoffModel:'stand-in'}).matchesPaper],[null,'stand-in',false]);
  assert.throws(()=>locatorStage({PAPER_LOCATOR_REASONING_EFFORT:'very high'}),/INVALID_REASONING_EFFORT/);
});

test('locateRun stores one prediction per model, waits on a hand-off, and never touches the clues',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-locate-'));
  try{
    const store=new PaperStore(directory);const stage=locatorStage({},{handoffModel:'stand-in'});const llm=handoffLlm(store.handoffDirectory);
    const run=store.createRun({width:10,height:10,sha256:'s'},Buffer.from('photo'),{});
    run.status='extracted';run.clues=[{id:'clue-0',category:'Sign',detail:'A',taxonomy:null}];store.saveRun(run);
    const parked=await locateRun({store,run:store.getRun(run.id),stage,llm});
    assert.equal(parked.pending.stage,'locator');assert.deepEqual(parked.predictions,[]);assert.deepEqual(parked.errors,[]);
    const request=pendingHandoffs(store.handoffDirectory)[0];
    // The stand-in gets the verbatim prompt and the stored analysis image, nothing else.
    assert.equal(readFileSync(resolve(request.directory,'prompt.txt'),'utf8'),cotLocationPrompt(1));
    assert.deepEqual(readFileSync(resolve(request.directory,'image.jpg')),Buffer.from('photo'));
    writeFileSync(resolve(request.directory,'response.txt'),cotAnswer(['Sign reads "A"'],['1 Main St, Springfield, IL 62701']));
    const located=await locateRun({store,run:store.getRun(run.id),stage,llm});
    assert.equal(located.pending,undefined);assert.equal(located.predictions.length,1);
    const [prediction]=located.predictions;
    assert.deepEqual([prediction.model,prediction.transport,prediction.topN,prediction.status,prediction.matchesPaper,prediction.score],['stand-in','handoff',1,'answered',false,null]);
    assert.deepEqual([prediction.clueList,prediction.addressList],[['Sign reads "A"'],['1 Main St, Springfield, IL 62701']]);
    assert.deepEqual(located.clues,run.clues);assert.equal(located.status,'extracted');assert.deepEqual(located.modelCalls.map(c=>c.stage),['locator']);
    // Asking again does nothing; another model or Top-N adds a second prediction; --force replaces.
    const calls=[];const api=async call=>{calls.push(call);return {text:'No idea.',raw:{responseId:`r${calls.length}`}};};
    assert.equal((await locateRun({store,run:store.getRun(run.id),stage,llm:api})).predictions.length,1);assert.equal(calls.length,0);
    const other={...stage,model:'other',transport:'openai-responses'};
    const second=await locateRun({store,run:store.getRun(run.id),stage:other,llm:api});
    assert.deepEqual(second.predictions.map(p=>[p.model,p.status,p.addressList]),[['stand-in','answered',['1 Main St, Springfield, IL 62701']],['other','no_address',null]]);
    const forced=await locateRun({store,run:store.getRun(run.id),stage:other,llm:async()=>({text:cotAnswer([],['x']),raw:{responseId:'f'}}),force:true});
    assert.deepEqual(forced.predictions.map(p=>[p.model,p.status]),[['stand-in','answered'],['other','answered']]);
    const failed=await locateRun({store,run:store.getRun(run.id),stage:{...other,model:'third'},llm:async()=>{throw Object.assign(new Error('boom sk-secret'),{status:404,code:'model_not_found'});}});
    assert.deepEqual(failed.errors.map(e=>[e.stage,e.code,e.providerCode]),[['locator','STAGE_FAILED','model_not_found']]);assert.equal(failed.predictions.length,2);
    // Predictions are evaluation data: the mining corpus still comes from the Detector clues.
    assert.deepEqual(miningCorpus(store).map(r=>r.id),[run.id]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
