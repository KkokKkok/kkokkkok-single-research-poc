import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { FIGURE25_TABLE,FIGURE25_KOREAN,FIGURE25_SOURCE,figure25Categories } from '../lib/paper-taxonomy-figure25.mjs';
import { classifierPrompt } from '../lib/paper-prompts.mjs';
import { classifyClues } from '../lib/paper-pipeline.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { extractImage,classifyRun,mineTaxonomy,extractAndClassify } from '../lib/paper-runner.mjs';
import { paperStages } from '../lib/paper-llm.mjs';
import { handoffLlm,pendingHandoffs } from '../lib/paper-handoff.mjs';
import { taxonomyTally,buildPreviewHtml } from '../lib/paper-preview.mjs';

const sha256=text=>createHash('sha256').update(text).digest('hex');
const fence='```';
const detectorAnswer=json=>`List:\n${fence}python\ncandidate_categories = [\n"Signage Text"\n]\n${fence}\n\nThink: signs.\n\nJson:\n${fence}json\n${json}\n${fence}\n`;
const memoryAnswer=memory=>`(3)\nThink: add one.\nJson:\n${fence}json\n${JSON.stringify(memory,null,2)}\n${fence}`;
const listAnswer=numbers=>`Think: paired.\nlist:\n${fence}python\n[${numbers.join(', ')}]\n${fence}`;

test('the Figure 25 table is the transcription that was checked against the figure',()=>{
  // sha256 of JSON.stringify(FIGURE25_TABLE) as transcribed from the figure image: any edit shows here.
  assert.equal(sha256(JSON.stringify(FIGURE25_TABLE)),'5c8c955f465d75cd5540422e0f4dbf81a7063c81bd34414a5055fc41834a44b5');
  assert.deepEqual(FIGURE25_TABLE.map(group=>[group.category,group.clues.length]),[['Building Features',6],['Identification',10],['Urban Infrastructure',6],['Property Features',5],['Urban Planning',4]]);
  const categories=figure25Categories();
  assert.equal(categories.length,31);assert.equal(new Set(categories.map(category=>category.name)).size,31);
  assert.deepEqual(categories.map(category=>category.number),Array.from({length:31},(_,index)=>index+1));
  // Figure order, not alphabetical; the definition slot holds only the figure's own words.
  assert.deepEqual([categories[0].name,categories[10].name,categories[30].name],['Residential Architecture','Commercial Signage','Safety Elements']);
  assert.deepEqual(categories[10],{number:11,name:'Commercial Signage',definition:'Category: Identification. Example: Business name, car share service, maintenance shop sign',group:'Identification',example:'Business name, car share service, maintenance shop sign'});
  assert.ok(categories.every(category=>category.definition===`Category: ${category.group}. Example: ${category.example}`));
  assert.equal(FIGURE25_SOURCE.verbatim,true);
  // Every name and group has a Korean display name, and nothing else does.
  const names=[...FIGURE25_TABLE.map(group=>group.category),...categories.map(category=>category.name)];
  assert.deepEqual(Object.keys(FIGURE25_KOREAN).sort(),names.slice().sort());
  // Korean names are for display only: the classifier prompt carries the English table.
  const prompt=classifierPrompt(['Sign: "CAFE"'],categories);
  assert.ok(prompt.includes('"11. Commercial Signage": "Category: Identification. Example: Business name, car share service, maintenance shop sign"'));
  assert.ok(!/[가-힣]/.test(prompt));
});

test('classification carries the group of a grouped taxonomy',async()=>{
  const categories=figure25Categories();
  const clues=[{id:'clue-0',category:'Sign',detail:'"CAFE"',taxonomy:null},{id:'clue-1',category:'Trees',detail:'maples',taxonomy:null}];
  const result=await classifyClues({clues,categories,model:'m',llm:async()=>({text:listAnswer([11,25]),raw:{}})});
  assert.deepEqual(result.clues.map(clue=>clue.taxonomy),[{number:11,name:'Commercial Signage',group:'Identification'},{number:25,name:'Plant Types',group:'Property Features'}]);
  await assert.rejects(classifyClues({clues,categories,model:'m',llm:async()=>({text:listAnswer([11,32]),raw:{}})}),/CLASSIFIER_NUMBER_OUT_OF_RANGE/);
});

test('mining can grow an existing taxonomy instead of starting from an empty list',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-taxonomy-'));
  try{
    const store=new PaperStore(directory);
    const stages={detector:{model:'d',reasoningEffort:null,matchesPaper:false},clueMiner:{model:'a',reasoningEffort:null,matchesPaper:false},classifier:{model:'c',reasoningEffort:null,matchesPaper:false}};
    const seed=store.saveTaxonomy({categories:figure25Categories(),model:null,stage:null,source:{kind:'paper_figure',...FIGURE25_SOURCE}});
    assert.equal(store.latestTaxonomy().id,seed.id);assert.equal(seed.categories[10].group,'Identification');
    await extractImage({store,prepared:{bytes:Buffer.from('one'),image:{width:10,height:10,sha256:sha256('one')}},stages,llm:async()=>({text:detectorAnswer('{"Overlay": "caption text"}'),raw:{}})});
    const prompts=[];
    // The analyzer keeps every category, renames nothing, and adds one the table lacks.
    const llm=async({text})=>{prompts.push(text);return {text:memoryAnswer({...Object.fromEntries(seed.categories.map(category=>[category.name,category.definition])),'Overlay Caption':'Text added to the photo after it was taken.'}),raw:{}};};
    const mined=await mineTaxonomy({store,stage:stages.clueMiner,llm,seedTaxonomy:seed});
    // The first prompt already holds the 31 types as memory.
    assert.ok(prompts[0].includes('"Commercial Signage": "Category: Identification. Example: Business name, car share service, maintenance shop sign"'));
    assert.equal(mined.taxonomy.categories.length,32);assert.equal(mined.converged,true);
    assert.deepEqual([mined.taxonomy.source.kind,mined.taxonomy.source.seedTaxonomyId],['clueminer',seed.id]);
    const byName=Object.fromEntries(mined.taxonomy.categories.map(category=>[category.name,category]));
    assert.equal(byName['Commercial Signage'].group,'Identification');assert.equal('group' in byName['Overlay Caption'],false);
    // A mined taxonomy is renumbered alphabetically, so its numbers differ from the figure's.
    assert.deepEqual(mined.taxonomy.categories.map(category=>category.number),Array.from({length:32},(_,index)=>index+1));
    assert.notEqual(mined.taxonomy.id,seed.id);assert.equal(store.getTaxonomy(seed.id).categories.length,31);
    // Without a seed the memory starts empty, as in the paper.
    const empty=[];
    await mineTaxonomy({store,stage:stages.clueMiner,llm:async({text})=>{empty.push(text);return {text:memoryAnswer({'Overlay Caption':'x'}),raw:{}};}});
    assert.ok(!empty[0].includes('Commercial Signage'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a hand-off extraction with a taxonomy stays one record through both waits',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-resume-'));
  try{
    const store=new PaperStore(directory),llm=handoffLlm(store.handoffDirectory),stages=paperStages({},{handoffModel:'stand-in'});
    const taxonomy=store.saveTaxonomy({categories:figure25Categories(),model:null,stage:null,source:{kind:'paper_figure'}});
    const prepared={bytes:Buffer.from('photo'),image:{width:10,height:10,sha256:sha256('photo')}};
    const answer=text=>{const waiting=pendingHandoffs(store.handoffDirectory);assert.equal(waiting.length,1);writeFileSync(resolve(waiting[0].directory,'response.txt'),text);};
    const step=()=>extractAndClassify({store,prepared,stages,llm,taxonomy,resume:true});
    const first=await step();
    assert.deepEqual([first.status,first.pending.stage],['pending','detector']);
    answer(detectorAnswer('{"Shop Sign": "reads \\"CAFE\\"", "Trees": "maples"}'));
    const second=await step();
    assert.deepEqual([second.id,second.status,second.pending.stage],[first.id,'extracted','classifier']);
    // Asked again before the classifier answer exists: still the same record, nothing new requested.
    const again=await step();
    assert.deepEqual([again.id,again.status,store.listRuns().length,pendingHandoffs(store.handoffDirectory).length],[first.id,'extracted',1,1]);
    answer(listAnswer([11,25]));
    const done=await step();
    assert.deepEqual([done.id,done.status,done.pending],[first.id,'classified',undefined]);
    assert.deepEqual(done.clues.map(clue=>clue.taxonomy.name),['Commercial Signage','Plant Types']);
    assert.equal(store.listRuns().length,1);assert.equal(store.findPendingRun(prepared.image.sha256),null);
    // A record parked by another step (region linking) is not taken for an unfinished extraction.
    store.saveRun({...done,pending:{stage:'regionTargets',id:'x'}});
    assert.equal(store.findPendingRun(prepared.image.sha256),null);
    // Without resume (the API path) the same image is extracted again as a new record.
    const fresh=await extractAndClassify({store,prepared,stages,llm:async({imageBytes})=>({text:imageBytes?detectorAnswer('{"Trees": "oak"}'):listAnswer([25]),raw:{}}),taxonomy});
    assert.notEqual(fresh.id,first.id);assert.equal(fresh.status,'classified');assert.equal(store.listRuns().length,2);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the tally counts classified clues per category of one taxonomy, with place-search hits and reviewer marks',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-tally-'));
  try{
    const store=new PaperStore(directory);
    const stages={detector:{model:'d',reasoningEffort:null,matchesPaper:false},classifier:{model:'c',reasoningEffort:null,matchesPaper:false}};
    const taxonomy=store.saveTaxonomy({categories:figure25Categories(),model:null,stage:null,source:{kind:'paper_figure'}});
    const make=async(tag,json,numbers)=>{
      const run=await extractImage({store,prepared:{bytes:Buffer.from(tag),image:{width:10,height:10,sha256:sha256(tag)}},stages,llm:async()=>({text:detectorAnswer(json),raw:{}})});
      return classifyRun({store,run,taxonomy,stage:stages.classifier,llm:async()=>({text:listAnswer(numbers),raw:{}})});
    };
    const first=await make('one','{"Shop Sign": "reads \\"CAFE <b>\\"", "Caption": "overlay text", "Trees": "maples"}',[11,11,25]);
    const second=await make('two','{"Trees": "pines"}',[25]);
    first.placeSearches=[{query:'CAFE <b>',topWithinRadius:true,clueIds:['clue-0']},{query:'other',topWithinRadius:false,clueIds:['clue-1']}];
    const other={...second,id:'other',classification:{...second.classification,taxonomyId:'another',classifiedAt:'2000-01-01T00:00:00.000Z'}};
    const entries=[{run:first,korean:{poorFit:['clue-1']}},{run:second},{run:other},{run:{...second,id:'plain',classification:null,clues:second.clues.map(clue=>({...clue,taxonomy:null}))}}];
    const tally=taxonomyTally(entries);
    assert.deepEqual([tally.taxonomyId,tally.photos,tally.clues,tally.poorFit],[taxonomy.id,2,4,1]);
    assert.deepEqual(tally.rows,[
      {number:11,name:'Commercial Signage',group:'Identification',clues:2,revealing:1,poorFit:1,photos:1},
      {number:25,name:'Plant Types',group:'Property Features',clues:2,revealing:0,poorFit:0,photos:2},
    ]);
    assert.deepEqual(taxonomyTally(entries,'another').rows.map(row=>[row.number,row.clues]),[[25,1]]);
    assert.deepEqual(taxonomyTally([]).rows,[]);
    const html=buildPreviewHtml(entries.slice(0,2).map(entry=>({...entry,overlay:Buffer.from('x')})),{generatedAt:'now',taxonomyLabels:FIGURE25_KOREAN});
    assert.ok(html.includes('범주별 집계'));assert.ok(html.includes('11. 상업 간판 <span class="taxonomy">Commercial Signage</span>'));
    assert.ok(html.includes('→ 11. 상업 간판 (Commercial Signage) · 식별 표지 (Identification)</span> <span class="misfit">맞는 범주 없음</span>'));
    assert.ok(!html.includes('<b>'));
    // No classified record: no tally section.
    assert.ok(!buildPreviewHtml([{run:{...second,classification:null,clues:second.clues.map(clue=>({...clue,taxonomy:null}))},overlay:Buffer.from('x')}],{generatedAt:'now'}).includes('범주별 집계'));
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('mining a chosen set of records feeds the clue lists of their address predictions, not Detector clues',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-mine-input-'));
  try{
    const store=new PaperStore(directory);
    const stages={detector:{model:'d',reasoningEffort:null,matchesPaper:false},clueMiner:{model:'a',reasoningEffort:null,matchesPaper:false},classifier:{model:'c',reasoningEffort:null,matchesPaper:false}};
    // One record with Detector clues and a prediction, one registered record with a prediction only,
    // one extracted record with no prediction (not chosen).
    const extracted=await extractImage({store,prepared:{bytes:Buffer.from('one'),image:{width:10,height:10,sha256:sha256('one')}},stages,llm:async()=>({text:detectorAnswer('{"Overlay": "detector text"}'),raw:{}})});
    extracted.predictions=[{status:'answered',clueList:['gate lettering','hill behind the gate'],addressList:['a']}];store.saveRun(extracted);
    const registered=store.registerRun({width:10,height:10,sha256:sha256('two')},Buffer.from('two'),stages);
    registered.predictions=[{status:'answered',clueList:['subway exit sign'],addressList:['b']}];store.saveRun(registered);
    const other=await extractImage({store,prepared:{bytes:Buffer.from('three'),image:{width:10,height:10,sha256:sha256('three')}},stages,llm:async()=>({text:detectorAnswer('{"Tree": "unchosen detector text"}'),raw:{}})});
    const prompts=[];
    const llm=async({text})=>{prompts.push(text);return {text:memoryAnswer({'Signage':'Text on signs.'}),raw:{}};};
    const mined=await mineTaxonomy({store,stage:stages.clueMiner,llm,runIds:[extracted.id,registered.id],inputSelection:'input-test'});
    const all=prompts.join('\n');
    // The entry goes into the prompt as a JSON string, so its line break is written as \n.
    assert.ok(all.includes('- gate lettering\\n- hill behind the gate'));assert.ok(all.includes('- subway exit sign'));
    assert.ok(!all.includes('detector text'));
    assert.deepEqual(mined.taxonomy.source.runIds.slice().sort(),[extracted.id,registered.id].sort());
    assert.deepEqual([mined.taxonomy.source.clueSource,mined.taxonomy.source.inputSelection],['cot_prediction_clue_list','input-test']);
    // A chosen record without a clue list stops the run before any model call.
    await assert.rejects(mineTaxonomy({store,stage:stages.clueMiner,llm,runIds:[other.id]}),/INPUT_RUN_WITHOUT_CLUE_LIST/);
    // Without runIds the Detector clues are mined, as before; a registered record has none and is left out.
    const before=[];
    const detectorRun=await mineTaxonomy({store,stage:stages.clueMiner,llm:async({text})=>{before.push(text);return {text:memoryAnswer({'Signage':'Text on signs.'}),raw:{}};}});
    assert.equal(detectorRun.taxonomy.source.clueSource,'geominer_detector');assert.ok(before.join('\n').includes('detector text'));
    assert.deepEqual(detectorRun.taxonomy.source.runIds.slice().sort(),[extracted.id,other.id].sort());
  }finally{rmSync(directory,{recursive:true,force:true});}
});
