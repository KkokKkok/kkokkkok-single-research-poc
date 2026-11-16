import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DETECTOR_PROMPT,CLUEMINER_ANALYZER_TEMPLATE,CLASSIFIER_TEMPLATE,PROMPT_SOURCES,clueMinerPrompt,classifierPrompt } from '../lib/paper-prompts.mjs';
import { extractDetectorJson,parseDetectorAnswer,extractClues,clueText,entryText,parseMemoryResponse,acceptMemory,mineCategories,numberTaxonomy,shuffled,parseClassifierAnswer,classifyClues } from '../lib/paper-pipeline.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { paperStages,buildRequest,PAPER_STAGE_REFERENCE } from '../lib/paper-llm.mjs';
import { handoffLlm,handoffBrief,pendingHandoffs } from '../lib/paper-handoff.mjs';
import { extractImage,classifyRun,mineTaxonomy,miningCorpus } from '../lib/paper-runner.mjs';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const fence='```';
const detectorAnswer=json=>`List:\n${fence}python\ncandidate_categories = [\n"Signage Text",\n"Vegetation"\n]\n${fence}\n\nThink: signs and trees.\n\nJson:\n${fence}json\n# Put your json here.\n${json}\n${fence}\n`;
const memoryAnswer=memory=>`${fence}python\ncandidate_categories = [\n"Sign Text"\n]\n${fence}\n(3)\nThink: add one.\nJson:\n${fence}json\n${JSON.stringify(memory,null,2)}\n${fence}`;
const listAnswer=numbers=>`Think: paired.\nlist:\n${fence}python\n[${numbers.join(', ')}]\n${fence}`;
// Replays scripted answers and records every call.
function scriptedLlm(answers){const calls=[];const llm=async call=>{calls.push(call);const next=answers[calls.length-1];if(next instanceof Error)throw next;return {text:typeof next==='function'?next(call):next,raw:{responseId:`r-${calls.length}`,usage:null}};};llm.calls=calls;return llm;}

test('verbatim prompts are byte-identical to the DoxBench sources',()=>{
  // sha256 of the strings in experiment.py get_geominer_detector_prompt() and clueminer.py _get_user_prompt().
  assert.equal(sha256(DETECTOR_PROMPT),'ffb8a92d0ee9721c25b6c68d9973b4815986560f9689cee1170510460f59f198');
  assert.equal(sha256(CLUEMINER_ANALYZER_TEMPLATE),'b9027f98a99e8ac38d2471d5c962ff2da5e8c0a00fa27b5e5ded123f7dde49cc');
  // Same text Python's f-string and json.dumps(ensure_ascii=False, indent=2) produce for these inputs.
  const entry=['- Brick façade with white trim\n- 한글 간판 "약국"'];
  assert.equal(sha256(clueMinerPrompt(entry,{'Street Layout':'Arrangement of roads.','Sign Text':'Text on signs.'})),'b1d80efa5a57bfe977e6b1cff0a200bea740b07eb61a49bd6c07f8ac8b1cbd08');
  assert.equal(sha256(clueMinerPrompt(entry,{})),'cbf858a61fd37dd1c2d14df7ac3989ec545179bb116981223e40e324fe15b6d5');
  // sha256 of Figure 7 (arXiv:2504.19373v5, Appendix H.2) after undoing the typesetting listed in paper-prompts.mjs.
  assert.equal(sha256(CLASSIFIER_TEMPLATE),'c22f34c5506d71fb583a2f91a6ac500d4bc6dbda3b5b50343ee58a33daa5b2fd');
  assert.equal(CLASSIFIER_TEMPLATE.split('\n')[0],'You are an expert working on multi-object classification task. Now you have a multi-object classification task.');
  assert.ok(!/[^\x00-\x7e]/.test(CLASSIFIER_TEMPLATE));assert.ok(!CLASSIFIER_TEMPLATE.includes('\n\n'));
  const classifier=classifierPrompt(['Sign Text: $& PHARMACY'],[{number:1,name:'Sign Text',definition:'Text on signs.'}]);
  assert.deepEqual([PROMPT_SOURCES.detector.verbatim,PROMPT_SOURCES.clueMinerAnalyzer.verbatim,PROMPT_SOURCES.classifier.verbatim],[true,true,true]);
  assert.match(classifier,/"1\. Sign Text": "Text on signs\."/);assert.ok(classifier.includes('"Sign Text: $& PHARMACY"'));assert.ok(!classifier.includes('<<'));
});

test('detector answers are extracted with the repository patterns',()=>{
  assert.equal(extractDetectorJson(detectorAnswer('{"Signage​ Text": "PHARMACY"}')),'{"Signage Text": "PHARMACY"}');
  assert.equal(extractDetectorJson(`no label\n${fence}json\n{"A": "b"}\n${fence}`),'{"A": "b"}');
  assert.equal(extractDetectorJson('I cannot help with that.'),'');assert.equal(extractDetectorJson(null),'');
  const parsed=parseDetectorAnswer(detectorAnswer('{"Signage Text": " PHARMACY sign ", "Vegetation": ["palms", "hedge"], "Road": {"side": "left"}, "Empty": "  "}'));
  assert.deepEqual(parsed.candidateCategories,['Signage Text','Vegetation']);
  assert.deepEqual(parsed.clues.map(c=>[c.id,c.category,c.detail,c.valueType]),[['clue-0','Signage Text','PHARMACY sign','string'],['clue-1','Vegetation','palms; hedge','string_array'],['clue-2','Road','{"side":"left"}','structured']]);
  assert.ok(parsed.clues.every(c=>c.taxonomy===null));
  assert.equal(clueText(parsed.clues[0]),'Signage Text: PHARMACY sign');assert.equal(entryText(parsed.clues.slice(0,2)),'- Signage Text: PHARMACY sign\n- Vegetation: palms; hedge');
  assert.throws(()=>parseDetectorAnswer('refused'),/DETECTOR_JSON_MISSING/);
  assert.throws(()=>parseDetectorAnswer(detectorAnswer('{"A": "b",}')),/DETECTOR_JSON_INVALID/);
  assert.throws(()=>parseDetectorAnswer(detectorAnswer('["a"]')),/DETECTOR_JSON_(MISSING|INVALID)/);
});

test('extractClues sends the verbatim prompt with the image and retries an unparseable answer',async()=>{
  const llm=scriptedLlm(['Sorry.',detectorAnswer('{"Sign Text": "PHARMACY"}')]);const recorded=[];const bytes=Buffer.from('image');
  const result=await extractClues({bytes,model:'m',llm,onCall:call=>recorded.push(call)});
  assert.equal(result.attempts,2);assert.equal(result.clues.length,1);
  assert.deepEqual(llm.calls.map(c=>[c.model,c.text===DETECTOR_PROMPT,c.imageBytes===bytes]),[['m',true,true],['m',true,true]]);
  assert.deepEqual(recorded.map(c=>[c.stage,c.attempt,c.rawOutputText==='Sorry.']),[['detector',1,true],['detector',2,false]]);
  await assert.rejects(extractClues({bytes,model:'m',llm:scriptedLlm(['a','b'])}),/DETECTOR_JSON_MISSING/);
});

test('memory answers are parsed and guarded as in clueminer.py',()=>{
  assert.deepEqual(parseMemoryResponse('{"A": "a"}'),{A:'a'});
  assert.deepEqual(parseMemoryResponse(memoryAnswer({A:'a',B:'b'})),{A:'a',B:'b'});
  assert.deepEqual(parseMemoryResponse(`Think: use {braces} here.\nJson:\n${fence}json\n# whole memory\n{"A": "a"}\n${fence}`),{A:'a'});
  assert.equal(parseMemoryResponse(''),null);assert.equal(parseMemoryResponse('no json'),null);assert.equal(parseMemoryResponse('[1,2]'),null);
  const memory=Object.fromEntries(Array.from({length:10},(_,i)=>[`C${i}`,'d']));
  assert.deepEqual(acceptMemory(memory,null),{memory,skipped:true,reason:'JSON parsing failed'});
  assert.equal(acceptMemory(memory,{A:['not','text']}).reason,'Invalid response format');
  assert.equal(acceptMemory(memory,{A:'a'}).reason,'Too many categories deleted: 9');
  assert.deepEqual(acceptMemory(memory,{A:'a',B:'b'}),{memory:{A:'a',B:'b'},skipped:false,reason:''});
});

test('mineCategories feeds one entry at a time, keeps memory on a rejected answer and stops when a round changes nothing',async()=>{
  const entries=[{key:'one',text:'- Sign Text: PHARMACY'},{key:'two',text:'- Vegetation: palms'}];
  const llm=scriptedLlm([memoryAnswer({'Sign Text':'s'}),'garbage',memoryAnswer({'Sign Text':'s','Vegetation Features':'v'}),memoryAnswer({'Vegetation Features':'v','Sign Text':'s'}),memoryAnswer({'Sign Text':'s','Vegetation Features':'v'}),memoryAnswer({'Sign Text':'s','Vegetation Features':'v'})]);
  const steps=[];
  const result=await mineCategories({entries,model:'m',llm,onStep:step=>steps.push(step)});
  assert.deepEqual(result,{memory:{'Sign Text':'s','Vegetation Features':'v'},rounds:3,converged:true});
  assert.equal(llm.calls.length,6);assert.ok(llm.calls.every(c=>!c.imageBytes));
  assert.equal(llm.calls[0].text,clueMinerPrompt([entries[0].text],{}));
  assert.equal(llm.calls[1].text,clueMinerPrompt([entries[1].text],{'Sign Text':'s'}));
  assert.equal(llm.calls[2].text,clueMinerPrompt([entries[0].text],{'Sign Text':'s'}));
  const entrySteps=steps.filter(s=>!s.roundFinished);
  assert.deepEqual(entrySteps.map(s=>[s.round,s.entryIndex,s.skipped]),[[1,1,false],[1,2,true],[2,1,false],[2,2,false],[3,1,false],[3,2,false]]);
  assert.equal(entrySteps[1].reason,'JSON parsing failed');assert.deepEqual(entrySteps[1].memory,{'Sign Text':'s'});
  assert.deepEqual(steps.filter(s=>s.roundFinished).map(s=>[s.roundFinished,s.state.round,s.state.index]),[[1,2,0],[2,3,0]]);
  // Resuming from a saved state only asks for the entries that are left.
  const rest=scriptedLlm([memoryAnswer({'Sign Text':'s','Vegetation Features':'v'})]);
  const resumed=await mineCategories({entries,model:'m',llm:rest,state:{round:2,index:1,memory:{'Sign Text':'s','Vegetation Features':'v'},roundStartMemory:{'Sign Text':'s','Vegetation Features':'v'}}});
  assert.equal(rest.calls.length,1);assert.equal(resumed.converged,true);assert.equal(resumed.rounds,2);
  const capped=await mineCategories({entries:[entries[0]],model:'m',maxRounds:2,llm:scriptedLlm([memoryAnswer({A:'1'}),memoryAnswer({A:'2'})])});
  assert.deepEqual(capped,{memory:{A:'2'},rounds:2,converged:false});
});

test('taxonomy numbering follows the alphabetical final_categories order and shuffling is repeatable',()=>{
  assert.deepEqual(numberTaxonomy({b:'3',A:'1',a:'2'}),[{number:1,name:'A',definition:'1'},{number:2,name:'a',definition:'2'},{number:3,name:'b',definition:'3'}]);
  const items=[1,2,3,4,5,6,7,8];
  assert.deepEqual(shuffled(items,42),shuffled(items,42));assert.notDeepEqual(shuffled(items,42),shuffled(items,7));
  assert.deepEqual([...shuffled(items,42)].sort(),items);assert.deepEqual(items,[1,2,3,4,5,6,7,8]);
});

test('classifier answers must give one in-range category number per clue',async()=>{
  assert.deepEqual(parseClassifierAnswer(listAnswer([2,1,2]),3,2),[2,1,2]);
  assert.deepEqual(parseClassifierAnswer(`list:\n${fence}python\n[1, 1]\n${fence}\nCorrection.\nlist:\n${fence}python\n[2, # second\n 1]\n${fence}`,2,2),[2,1]);
  assert.deepEqual(parseClassifierAnswer('list: [1,2]',2,2),[1,2]);
  assert.throws(()=>parseClassifierAnswer('Think only.',1,2),/CLASSIFIER_LIST_MISSING/);
  assert.throws(()=>parseClassifierAnswer(`list:\n${fence}python\n[#Examples: 1,2,3, ......]\n${fence}`,3,3),/CLASSIFIER_LIST_INVALID/);
  assert.throws(()=>parseClassifierAnswer(listAnswer([1]),2,2),/CLASSIFIER_COUNT_MISMATCH/);
  assert.throws(()=>parseClassifierAnswer(listAnswer([0,3]),2,2),/CLASSIFIER_NUMBER_OUT_OF_RANGE/);
  const clues=[{id:'clue-0',category:'Sign',detail:'PHARMACY',taxonomy:null},{id:'clue-1',category:'Trees',detail:'palms',taxonomy:null}];
  const categories=[{number:1,name:'Sign Text',definition:'s'},{number:2,name:'Vegetation Features',definition:'v'}];
  const llm=scriptedLlm([listAnswer([1]),listAnswer([1,2])]);
  const result=await classifyClues({clues,categories,model:'m',llm});
  assert.equal(result.attempts,2);assert.deepEqual(result.clues.map(c=>c.taxonomy),[{number:1,name:'Sign Text'},{number:2,name:'Vegetation Features'}]);
  assert.equal(llm.calls[0].text,classifierPrompt(['Sign: PHARMACY','Trees: palms'],categories));
  await assert.rejects(classifyClues({clues,categories,model:'m',llm:scriptedLlm([listAnswer([9,9]),'x'])}),/CLASSIFIER_LIST_MISSING/);
  assert.deepEqual(await classifyClues({clues:[],categories,model:'m',llm:scriptedLlm([])}),{clues:[],answer:null,attempts:0});
});

test('stages run on the configured current model, record the paper reference, and send reasoning only when set',async()=>{
  // Reference only: experiment.py --geominer_detector_model default (gpt4o) and clueminer.py LLMConfig.model.
  assert.deepEqual(Object.fromEntries(Object.entries(PAPER_STAGE_REFERENCE).map(([name,stage])=>[name,[stage.model,stage.reasoningEffort]])),{detector:['gpt-4o-2024-11-20',null],clueMiner:['o4-mini-2025-04-16',null],classifier:['o4-mini-2025-04-16',null]});
  const current=paperStages({OPENAI_MODEL:'gpt-5.4-mini'});
  assert.deepEqual(Object.fromEntries(Object.entries(current).map(([name,stage])=>[name,[stage.model,stage.reasoningEffort,stage.matchesPaper,stage.maxOutputTokens,stage.transport,stage.paperModel]])),{
    detector:['gpt-5.4-mini',null,false,16384,'openai-responses','gpt-4o-2024-11-20'],clueMiner:['gpt-5.4-mini',null,false,16384,'openai-responses','o4-mini-2025-04-16'],classifier:['gpt-5.4-mini',null,false,16384,'openai-responses','o4-mini-2025-04-16']});
  // No model name is built in: without configuration there is nothing to call.
  assert.deepEqual(Object.values(paperStages({})).map(stage=>stage.model),[null,null,null]);
  const custom=paperStages({OPENAI_MODEL:'gpt-5.4-mini',PAPER_DETECTOR_MODEL:' gpt-4o-2024-11-20 ',PAPER_CLUEMINER_MODEL:'o4-mini-2025-04-16',PAPER_CLUEMINER_REASONING_EFFORT:'Medium'});
  assert.deepEqual([custom.detector.model,custom.detector.matchesPaper],['gpt-4o-2024-11-20',true]);
  // Sending an effort the repository does not send is a departure, even on the paper's model.
  assert.deepEqual([custom.clueMiner.model,custom.clueMiner.reasoningEffort,custom.clueMiner.matchesPaper],['o4-mini-2025-04-16','medium',false]);
  assert.deepEqual([custom.classifier.model,custom.classifier.matchesPaper],['gpt-5.4-mini',false]);
  assert.throws(()=>paperStages({PAPER_CLASSIFIER_REASONING_EFFORT:'very high'}),/INVALID_REASONING_EFFORT/);
  // A stand-in answering through files is never the paper's setting and has no API parameters.
  const standIn=paperStages({OPENAI_MODEL:'gpt-5.4-mini',PAPER_DETECTOR_REASONING_EFFORT:'high'},{handoffModel:'claude-fable-5-2'});
  assert.deepEqual(Object.values(standIn).map(stage=>[stage.model,stage.transport,stage.reasoningEffort,stage.maxOutputTokens,stage.matchesPaper]),Array(3).fill(['claude-fable-5-2','handoff',null,null,false]));

  assert.deepEqual(buildRequest({model:'m',text:'p'}),{model:'m',store:false,max_output_tokens:16384,input:[{role:'user',content:[{type:'input_text',text:'p'}]}]});
  const request=buildRequest({model:'m',text:'p',imageBytes:Buffer.from('img'),reasoningEffort:'medium'});
  assert.deepEqual(request.reasoning,{effort:'medium'});
  assert.deepEqual(request.input[0].content.map(part=>part.type),['input_text','input_image']);
  assert.equal(request.input[0].content[1].image_url,`data:image/jpeg;base64,${Buffer.from('img').toString('base64')}`);
  assert.deepEqual(Object.keys(request).sort(),['input','max_output_tokens','model','reasoning','store']);

  const llm=scriptedLlm([detectorAnswer('{"Sign": "PHARMACY"}'),listAnswer([1])]);
  await extractClues({bytes:Buffer.from('i'),model:'m',reasoningEffort:'low',llm});
  await classifyClues({clues:[{id:'clue-0',category:'Sign',detail:'PHARMACY',taxonomy:null}],categories:[{number:1,name:'Sign Text',definition:'s'}],model:'m',llm});
  assert.deepEqual(llm.calls.map(call=>call.reasoningEffort),['low',null]);
});

test('runner stores extraction, mining logs, taxonomy and classification without touching cues.sqlite',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-cues-'));
  try{
    const store=new PaperStore(directory);const seen=[];
    const stages={detector:{model:'d',reasoningEffort:null,matchesPaper:false},clueMiner:{model:'a',reasoningEffort:'medium',matchesPaper:false},classifier:{model:'c',reasoningEffort:null,matchesPaper:false}};
    const prepared=(tag)=>({bytes:Buffer.from(tag),image:{width:10,height:10,sha256:sha256(tag)}});
    // Route by prompt, the way the real model sees the three different tasks.
    const taxonomyMemory={'Sign Text':'Text on signs.','Vegetation Features':'Plants.'};
    const llm=async({model,reasoningEffort,text,imageBytes})=>(seen.push([model,reasoningEffort,Boolean(imageBytes)]),{raw:{responseId:'r',usage:{total_tokens:1}},text:imageBytes?detectorAnswer(imageBytes.toString()==='two'?'{"Trees": "palms"}':'{"Sign": "PHARMACY", "Trees": "oak"}'):text.startsWith('Your task is to extract')?memoryAnswer(taxonomyMemory):listAnswer((text.match(/^\s+"[^"]+: /gm)||[]).map(line=>/Sign: /.test(line)?1:2))});
    const first=await extractImage({store,prepared:prepared('one'),stages,llm});
    const stale=await extractImage({store,prepared:prepared('two'),stages,llm:async()=>({text:detectorAnswer('{"Old": "superseded"}'),raw:{}})});
    const second=await extractImage({store,prepared:prepared('two'),stages,llm});
    const failed=await extractImage({store,prepared:prepared('three'),stages,llm:async()=>{throw Object.assign(new Error('401 Incorrect API key provided: sk-secret'),{status:401,code:'expired_secret_key'});}});
    assert.equal(first.status,'extracted');assert.equal(first.schemaVersion,'paper-clues-v2');assert.equal(first.detector.attempts,1);assert.equal(first.modelCalls.length,1);
    assert.deepEqual(first.stages,stages);assert.deepEqual(seen,[['d',null,true],['d',null,true]]);
    assert.deepEqual(failed.errors.map(e=>[e.stage,e.code,e.httpStatus,e.providerCode]),[['detector','STAGE_FAILED',401,'expired_secret_key']]);assert.ok(!JSON.stringify(failed).includes('sk-secret'));
    assert.deepEqual(store.image(first.id),Buffer.from('one'));
    assert.deepEqual(miningCorpus(store).map(run=>run.id).sort(),[first.id,second.id].sort());assert.ok(stale.id!==second.id);
    await assert.rejects(mineTaxonomy({store:new PaperStore(mkdtempSync(resolve(directory,'empty-'))),stage:stages.clueMiner,llm}),/NO_EXTRACTED_RUNS/);

    const mined=await mineTaxonomy({store,stage:stages.clueMiner,llm,seed:1});
    assert.equal(mined.converged,true);assert.equal(mined.rounds,2);
    // Every analyzer call carries the mining stage's model and reasoning setting, and no image.
    assert.deepEqual(seen.slice(2),Array(4).fill(['a','medium',false]));
    assert.equal(mined.taxonomy.model,'a');assert.deepEqual(mined.taxonomy.stage,stages.clueMiner);
    assert.deepEqual(mined.taxonomy.categories,[{number:1,name:'Sign Text',definition:'Text on signs.'},{number:2,name:'Vegetation Features',definition:'Plants.'}]);
    assert.deepEqual(mined.taxonomy.source.runIds.slice().sort(),[first.id,second.id].sort());assert.equal(mined.taxonomy.source.clueSource,'geominer_detector');
    assert.deepEqual(JSON.parse(readFileSync(resolve(mined.directory,'final_categories.json'),'utf8')),taxonomyMemory);
    const stepFiles=readdirSync(resolve(mined.directory,'steps'));assert.equal(stepFiles.length,4);
    const step=JSON.parse(readFileSync(resolve(mined.directory,'steps',stepFiles[0]),'utf8'));
    assert.equal(step.metadata.round,1);assert.equal(step.metadata.entry_skipped,false);assert.equal(step.input.single_entry.length,1);assert.deepEqual(step.output.parsed_categories,taxonomyMemory);
    assert.equal(store.latestTaxonomy().id,mined.taxonomy.id);assert.equal(store.getTaxonomy(mined.taxonomy.id).categories.length,2);
    const name=mined.taxonomy.source.miningRun;
    await assert.rejects(mineTaxonomy({store,stage:stages.clueMiner,llm,resume:name}),/MINING_ALREADY_CONVERGED/);
    await assert.rejects(mineTaxonomy({store,stage:stages.clueMiner,llm,resume:'missing'}),/CHECKPOINT_NOT_FOUND/);

    const laterClassifier={model:'c2',reasoningEffort:'low',matchesPaper:false};
    const classified=await classifyRun({store,run:store.getRun(first.id),taxonomy:mined.taxonomy,stage:laterClassifier,llm});
    assert.equal(classified.status,'classified');assert.equal(classified.classification.taxonomyId,mined.taxonomy.id);
    assert.deepEqual(seen.at(-1),['c2','low',false]);assert.deepEqual([classified.classification.model,classified.classification.reasoningEffort],['c2','low']);
    assert.deepEqual(classified.stages,{...stages,classifier:laterClassifier});
    assert.deepEqual(classified.clues.map(c=>[c.category,c.taxonomy.number,c.taxonomy.name]),[['Sign',1,'Sign Text'],['Trees',2,'Vegetation Features']]);
    assert.deepEqual(store.getRun(first.id).clues,classified.clues);
    const unclassified=await classifyRun({store,run:store.getRun(second.id),taxonomy:mined.taxonomy,stage:stages.classifier,llm:async()=>({text:'no list',raw:{}})});
    assert.equal(unclassified.status,'extracted');assert.equal(unclassified.classification,null);assert.deepEqual(unclassified.errors.map(e=>e.code),['CLASSIFIER_LIST_MISSING']);assert.ok(unclassified.clues.every(c=>c.taxonomy===null));
    assert.equal((await classifyRun({store,run:store.getRun(failed.id),taxonomy:mined.taxonomy,stage:stages.classifier,llm})).status,'failed');
    assert.equal(existsSync(resolve(directory,'cues.sqlite')),false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('file hand-off parks a request until its answer file exists, then continues in the same record',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-handoff-'));
  try{
    const store=new PaperStore(directory);const llm=handoffLlm(store.handoffDirectory);
    const stages=paperStages({},{handoffModel:'stand-in'});
    const prepared={bytes:Buffer.from('photo'),image:{width:10,height:10,sha256:sha256('photo')}};
    const answer=(request,text)=>writeFileSync(resolve(request.directory,'response.txt'),text);

    // Detector: the first call writes the request and waits.
    const parked=await extractImage({store,prepared,stages,llm});
    assert.equal(parked.status,'pending');assert.deepEqual(parked.errors,[]);assert.equal(parked.pending.stage,'detector');
    let waiting=pendingHandoffs(store.handoffDirectory);
    assert.equal(waiting.length,1);assert.equal(waiting[0].id,parked.pending.id);assert.equal(waiting[0].standIn,'stand-in');assert.equal(waiting[0].attempt,1);
    assert.equal(readFileSync(resolve(waiting[0].directory,'prompt.txt'),'utf8'),DETECTOR_PROMPT);
    assert.deepEqual(readFileSync(resolve(waiting[0].directory,'image.jpg')),Buffer.from('photo'));
    assert.ok(handoffBrief(waiting[0].directory).includes(waiting[0].directory));
    assert.equal(store.findPendingRun(prepared.image.sha256).id,parked.id);assert.deepEqual(miningCorpus(store),[]);
    // Asking again without an answer changes nothing and creates no second request.
    assert.equal((await extractImage({store,prepared,stages,llm,run:store.findPendingRun(prepared.image.sha256)})).status,'pending');
    assert.equal(pendingHandoffs(store.handoffDirectory).length,1);

    // An unparseable answer leads to a second attempt, which is a new request.
    answer(waiting[0],'I cannot help.');
    const retry=await extractImage({store,prepared,stages,llm,run:store.findPendingRun(prepared.image.sha256)});
    assert.equal(retry.status,'pending');assert.equal(retry.id,parked.id);
    waiting=pendingHandoffs(store.handoffDirectory);assert.equal(waiting.length,1);assert.equal(waiting[0].attempt,2);
    answer(waiting[0],'﻿'+detectorAnswer('{"Sign": "PHARMACY", "Trees": "palms"}'));
    const extracted=await extractImage({store,prepared,stages,llm,run:store.findPendingRun(prepared.image.sha256)});
    assert.equal(extracted.status,'extracted');assert.equal(extracted.id,parked.id);assert.equal(extracted.pending,undefined);assert.equal(extracted.clues.length,2);
    assert.equal(extracted.detector.attempts,2);
    // Both answers are on record once each, however often the command was re-run.
    assert.deepEqual(extracted.modelCalls.map(call=>[call.stage,call.attempt,call.transport,call.responseModel]),[['detector',1,'handoff','stand-in'],['detector',2,'handoff','stand-in']]);
    assert.equal(store.listRuns().length,1);assert.equal(store.findPendingRun(prepared.image.sha256),null);

    // Mining stops at each step and resumes from the unfinished run.
    await assert.rejects(mineTaxonomy({store,stage:stages.clueMiner,llm}),/HANDOFF_PENDING/);
    assert.equal(store.unfinishedMining().finished,false);
    for(let i=0;i<5;i++){
      waiting=pendingHandoffs(store.handoffDirectory);if(!waiting.length)break;
      answer(waiting[0],memoryAnswer({'Sign Text':'Text on signs.','Vegetation Features':'Plants.'}));
      try{await mineTaxonomy({store,stage:stages.clueMiner,llm,resume:store.unfinishedMining().name});}catch(error){assert.match(error.message,/HANDOFF_PENDING/);}
    }
    const taxonomy=store.latestTaxonomy();
    assert.deepEqual(taxonomy.categories.map(category=>category.name),['Sign Text','Vegetation Features']);
    assert.equal(taxonomy.stage.transport,'handoff');assert.equal(taxonomy.source.converged,true);assert.equal(store.unfinishedMining(),null);

    // Classification waits the same way and leaves the record untouched meanwhile.
    const waitingRun=await classifyRun({store,run:store.getRun(parked.id),taxonomy,stage:stages.classifier,llm});
    assert.equal(waitingRun.status,'extracted');assert.equal(waitingRun.pending.stage,'classifier');assert.deepEqual(waitingRun.errors,[]);
    answer(pendingHandoffs(store.handoffDirectory)[0],listAnswer([1,2]));
    const classified=await classifyRun({store,run:store.getRun(parked.id),taxonomy,stage:stages.classifier,llm});
    assert.equal(classified.status,'classified');assert.equal(classified.pending,undefined);assert.deepEqual(classified.clues.map(clue=>clue.taxonomy.number),[1,2]);
    assert.deepEqual(pendingHandoffs(store.handoffDirectory),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
