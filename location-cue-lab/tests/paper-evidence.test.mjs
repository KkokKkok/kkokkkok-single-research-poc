import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvidenceAnswer,normalizeClues,groupEvidence,assignClues,pendingChecks,parseCheckAnswer,sameText,evidenceKey,evidencePrompt,normalizeText,EVIDENCE_VERSION } from '../lib/paper-evidence.mjs';
import { normalizeRunEvidence,assignRunClues } from '../lib/paper-runner.mjs';

const answer=(evidence,skipped=[])=>'```json\n'+JSON.stringify({evidence,skipped})+'\n```';
const region=(id,kind,quoted)=>({id,kind,quoted,text:quoted});
// The same junction in two photos: other clue ids, other category names, other sentences, another split.
const photoA=[
  {id:'clue-0',category:'Language and Script',detail:'All visible text is Korean Hangul.',taxonomy:{number:84},regions:[]},
  {id:'clue-1',category:'Bus Route Marking',detail:'The bus body is marked "동작 21".',taxonomy:{number:71},regions:[region('clue-1-ocr-ocr-2','text','동작 21')]},
  {id:'clue-2',category:'Bus Type and Livery',detail:'Short, bright green bus.',taxonomy:{number:71},regions:[region('clue-2-dino-0-0','object',null)]},
  {id:'clue-3',category:'Building Signage',detail:'A partly obscured sign ending in "CHNOLOGY".',taxonomy:{number:29},regions:[]},
];
const photoB=[
  {id:'clue-0',category:'Public Transit Vehicle',detail:'Small light-green bus; the side reads "동작21".',taxonomy:{number:71},regions:[]},
  {id:'clue-1',category:'Text and Language',detail:'Hangul text on the bus.',taxonomy:{number:84},regions:[]},
  {id:'clue-2',category:'Estimated Location',detail:'Probably Dongjak-gu, Seoul.',taxonomy:{number:12},regions:[]},
  {id:'clue-3',category:'Signage',detail:'Sign reading "TECHNOLOGY".',taxonomy:{number:29},regions:[]},
];
const answerA=answer([
  {subject:'scene',aspect:'language',value:'hangul',clueIds:['clue-0']},
  {subject:'bus',aspect:'text',text:'동작 21',textComplete:true,clueIds:['clue-1']},
  {subject:'bus',aspect:'appearance',color:['green'],material:[],clueIds:['clue-2']},
  {subject:'building_sign',aspect:'text',text:'CHNOLOGY',textComplete:false,clueIds:['clue-3']},
]);
const answerB=answer([
  {subject:'bus',aspect:'appearance',color:['green'],clueIds:['clue-0']},
  {subject:'bus',aspect:'text',text:'동작21',clueIds:['clue-0']},
  {subject:'bus',aspect:'language',value:'hangul',clueIds:['clue-1']},   // a scene aspect is always on `scene`
  {subject:'building_sign',aspect:'text',text:'TECHNOLOGY',clueIds:['clue-3']},
],[{clueId:'clue-2',reason:'inference'}]);

test('the same evidence in two photos gets the same key',()=>{
  const a=parseEvidenceAnswer(answerA,photoA),b=parseEvidenceAnswer(answerB,photoB);
  assert.deepEqual(a.evidence.map(item=>item.key),['scene|language|hangul','text|동작21','bus|appearance','text|CHNOLOGY']);
  assert.deepEqual(a.evidence[1],{id:'ev-1',key:'text|동작21',subject:'bus',aspect:'text',text:'동작 21',textComplete:true,value:null,color:[],material:[],kinds:[71],clueIds:['clue-1'],regionIds:['clue-1-ocr-ocr-2']});
  assert.deepEqual(a.evidence[2].regionIds,['clue-2-dino-0-0']);
  assert.equal(a.evidence[3].textComplete,false);
  assert.deepEqual(b.skipped,[{clueId:'clue-2',reason:'inference'}]);
  // Counted together: eight records, four clues. The half-read sign joins the whole one.
  const grouped=groupEvidence([{runId:'a',evidence:a.evidence},{runId:'b',evidence:b.evidence}]);
  assert.equal(grouped.total,8);assert.equal(grouped.unique,4);
  assert.deepEqual(grouped.groups.map(group=>[group.key,group.members.map(member=>`${member.runId}:${member.id}`)]),[
    ['scene|language|hangul',['a:ev-0','b:ev-2']],['text|동작21',['a:ev-1','b:ev-1']],['bus|appearance',['a:ev-2','b:ev-0']],['text|TECHNOLOGY',['a:ev-3','b:ev-3']]]);
  assert.deepEqual(grouped.groups[3].texts,['CHNOLOGY','TECHNOLOGY']);
});

test('records of one key are one record: attributes and the carrier of a text are not in the key',()=>{
  const clues=[{id:'clue-0',category:'Architecture',detail:'Green glass tower.'},{id:'clue-1',category:'Facade',detail:'Pale stone building.'},{id:'clue-2',category:'Sign',detail:'"CAU" banner'},{id:'clue-3',category:'Logo',detail:'"cau" on the wall'}];
  const {evidence}=parseEvidenceAnswer(answer([
    {subject:'building',aspect:'appearance',color:['green','teal'],material:['glass'],clueIds:['clue-0']},
    {subject:'building',aspect:'appearance',color:['beige'],material:['stone'],clueIds:['clue-1']},
    {subject:'banner',aspect:'text',text:'CAU',clueIds:['clue-2']},
    {subject:'building_sign',aspect:'text',text:'cau',clueIds:['clue-3']},
  ]),clues);
  assert.deepEqual(evidence.map(item=>[item.key,item.clueIds]),[['building|appearance',['clue-0','clue-1']],['text|CAU',['clue-2','clue-3']]]);
  assert.deepEqual([evidence[0].color,evidence[0].material,evidence[1].subject],[['beige','green'],['glass','stone'],'banner']);
  assert.equal(normalizeText(' Ｃａｕ. '),'CAU');
  assert.equal(evidenceKey({subject:'road',aspect:'layout'}),'scene|layout');
  assert.equal(evidenceKey({subject:'scene',aspect:'season',value:'autumn'}),'scene|season');
});

test('strings read slightly differently in two photos are one text; different strings are not',()=>{
  assert.ok(sameText('동작 21','동작21'));
  assert.ok(sameText('메티스트수학','진학 매티스트수학'));     // a misread vowel and a word more
  assert.ok(sameText('지담치킨','치담치킨'));
  assert.ok(sameText('2277','869-2277'));
  assert.ok(sameText('PREMIUM','PREMIUM STUDY CAFE'));
  assert.ok(sameText('CAFÉ ÁN','cafe an'));                   // accents on Latin letters are dropped
  assert.ok(!sameText('LÚACHÍN','LIUCHIN'));                  // two letters apart in seven: too far, stays two clues
  assert.ok(!sameText('수학','진학 메티스트 수학'));            // a common word inside a long name
  assert.ok(!sameText('구역','교육환경보호구역'));
  assert.ok(!sameText('102','103'));                         // numbers have to be equal
  assert.ok(!sameText('8692277','8692278'));
  assert.ok(!sameText('30','1030'));                         // too short to be looked for inside another
  assert.ok(!sameText('S25','BHC'));
  assert.ok(!sameText('명인만두','지담치킨'));
  assert.ok(!sameText('PIZZAWAY','LOTTECAS'));
  assert.ok(!sameText('',''));
  // Other attributes of the same subject are one clue; another subject is another clue.
  const item=(id,subject,aspect,extra={})=>({id,subject,aspect,text:null,value:null,...extra});
  const grouped=groupEvidence([{runId:'a',evidence:[item('ev-0','road','appearance',{color:['red']}),item('ev-1','scene','season',{value:'autumn'}),item('ev-2','shop_sign','text',{text:'S25'})]},
    {runId:'b',evidence:[item('ev-0','road','appearance',{color:['grey']}),item('ev-1','scene','season',{value:'spring'}),item('ev-2','product','logo',{text:'s25'}),item('ev-3','pavement','appearance'),item('ev-4','building','layout'),item('ev-5','scene','layout'),item('ev-6','scene','language',{value:'hangul'}),item('ev-7','scene','language',{value:'latin'})]}]);
  assert.deepEqual(grouped.groups.map(group=>[group.key,group.members.length]),[['road|appearance',2],['scene|season',2],['text|S25',2],['pavement|appearance',1],['scene|layout',2],['scene|language|hangul',1],['scene|language|latin',1]]);
  assert.deepEqual([grouped.total,grouped.unique],[11,7]);
});

test('an answer outside the fixed form is refused',()=>{
  const clues=photoA.slice(0,2),ok={subject:'scene',aspect:'language',value:'hangul',clueIds:['clue-0']},bus={subject:'bus',aspect:'text',text:'동작 21',clueIds:['clue-1']};
  assert.equal(parseEvidenceAnswer(answer([ok,bus]),clues).evidence.length,2);
  assert.throws(()=>parseEvidenceAnswer('no json',clues),/EVIDENCE_ANSWER_INVALID/);
  assert.throws(()=>parseEvidenceAnswer(answer([ok]),clues),/EVIDENCE_ANSWER_INCOMPLETE/);                                   // clue-1 unaccounted for
  assert.throws(()=>parseEvidenceAnswer(answer([ok,{...bus,subject:'minibus'}]),clues),/EVIDENCE_ANSWER_VOCABULARY/);
  assert.throws(()=>parseEvidenceAnswer(answer([{...ok,value:'korean'},bus]),clues),/EVIDENCE_ANSWER_VOCABULARY/);
  assert.throws(()=>parseEvidenceAnswer(answer([ok,{...bus,text:'Dongjak 21'}]),clues),/EVIDENCE_ANSWER_TEXT_NOT_IN_CLUE/);  // romanised
  assert.throws(()=>parseEvidenceAnswer(answer([ok,{...bus,text:' '}]),clues),/EVIDENCE_ANSWER_TEXT_MISSING/);
  assert.throws(()=>parseEvidenceAnswer(answer([ok,{...bus,clueIds:['clue-7']}]),clues),/EVIDENCE_ANSWER_UNKNOWN_CLUE/);
  assert.throws(()=>parseEvidenceAnswer(answer([ok],[{clueId:'clue-1',reason:'boring'}]),clues),/EVIDENCE_ANSWER_VOCABULARY/);
});

test('the step repeats a refused answer and stores the evidence on the record',async()=>{
  const answers=['nonsense',answerA],calls=[];
  const llm=async({text,attempt})=>{calls.push(text);return {text:answers[attempt-1],raw:{responseId:`r${attempt}`}};};
  const result=await normalizeClues({clues:photoA,model:'m',llm});
  assert.equal(result.summary.attempts,2);assert.equal(result.summary.version,EVIDENCE_VERSION);
  assert.equal(calls[0],evidencePrompt(photoA));assert.ok(!calls[0].includes('taxonomy'));
  const saved=[],store={saveRun:run=>{saved.push(run);return run;}};
  const run={status:'classified',clues:photoA,modelCalls:[],errors:[{stage:'evidence',code:'OLD'}]};
  const done=await normalizeRunEvidence({store,run,stage:{model:'m',reasoningEffort:null},llm:async()=>({text:answerA,raw:{responseId:'r'}})});
  assert.equal(done.evidence.length,4);assert.equal(done.normalization.stage.model,'m');assert.deepEqual(done.errors,[]);
  // Already normalized: left alone without force.
  assert.equal(await normalizeRunEvidence({store,run:done,stage:{model:'m'},llm:async()=>{throw new Error('not called');}}),done);
  const failed=await normalizeRunEvidence({store,run:{status:'classified',clues:photoA,modelCalls:[],errors:[]},stage:{model:'m'},llm:async()=>({text:'nonsense',raw:{}})});
  assert.equal(failed.evidence,undefined);assert.equal(failed.errors[0].code,'EVIDENCE_ANSWER_INVALID');
});

test('a place hands out one id per clue, and marks what an earlier photo already showed',async()=>{
  const item=(id,subject,aspect,extra={})=>({id,subject,aspect,text:null,value:null,...extra});
  const first=[item('ev-0','shop_sign','text',{text:'메티스트수학'}),item('ev-1','road','appearance'),item('ev-2','scene','season',{value:'autumn'})];
  const second=[item('ev-0','scene','season',{value:'spring'}),item('ev-1','shop_sign','text',{text:'진학 매티스트 수학'}),item('ev-2','shop_sign','text',{text:'PIZZA WAY'}),item('ev-3','bus','appearance')];
  const a=assignClues(null,'run-a',first);
  assert.deepEqual(a.evidence.map(entry=>[entry.placeClueId,entry.seenBefore]),[['text|메티스트수학',false],['road|appearance',false],['scene|season',false]]);
  const b=assignClues(a.place,'run-b',second);
  // The sign read differently carries the id of its first sighting; new clues get their own.
  assert.deepEqual(b.evidence.map(entry=>[entry.placeClueId,entry.seenBefore]),[['scene|season',true],['text|메티스트수학',true],['text|PIZZAWAY',false],['bus|appearance',false]]);
  assert.deepEqual(b.place.clues.map(clue=>[clue.clueId,clue.runIds,clue.texts]),[['text|메티스트수학',['run-a','run-b'],['메티스트수학','진학 매티스트 수학']],['road|appearance',['run-a'],[]],['scene|season',['run-a','run-b'],[]],['text|PIZZAWAY',['run-b'],['PIZZA WAY']],['bus|appearance',['run-b'],[]]]);
  // Running a photo again changes nothing: the first photo stays the one that showed its clues first.
  const again=assignClues(b.place,'run-a',first);
  assert.deepEqual(again.evidence.map(entry=>entry.seenBefore),[false,false,false]);
  assert.deepEqual(again.place,b.place);
  assert.deepEqual(assignClues(again.place,'run-b',second).evidence,b.evidence);
  // On the record and in the store.
  const places=new Map(),store={getPlace:name=>places.get(name)??null,savePlace:place=>{places.set(place.name,place);return place;},saveRun:run=>run};
  const runA=await assignRunClues({store,run:{id:'run-a',evidence:first},place:'corner'}),runB=await assignRunClues({store,run:{id:'run-b',evidence:second},place:'corner'});
  assert.equal(runA.place,'corner');assert.deepEqual(runB.evidence.map(entry=>entry.seenBefore),[true,true,false,false]);
  assert.equal(places.get('corner').clues.length,5);
  assert.equal((await assignRunClues({store,run:{id:'run-c'},place:'corner'})).evidence,undefined);
});

test('a clue that narrows the place down is matched only when the photos show the same object',async()=>{
  const item=(id,subject,aspect='appearance')=>({id,subject,aspect,text:null,value:null,clueIds:['clue-0']});
  const risks={building:'high',gate:'medium',road:'low'},riskOf=entry=>risks[entry.subject];
  const first=[item('ev-0','building'),item('ev-1','gate'),item('ev-2','road')];
  const a=assignClues(null,'run-a',first,{riskOf});
  assert.deepEqual(a.place.clues.map(clue=>[clue.clueId,clue.risk]),[['building|appearance','high'],['gate|appearance','medium'],['road|appearance','low']]);
  // The next photo: the low clue is matched by its kind; the other two are asked about.
  const second=[item('ev-0','road'),item('ev-1','building'),item('ev-2','gate')];
  assert.deepEqual(pendingChecks(a.place,'run-b',second,riskOf),[{evidenceId:'ev-1',clueId:'building|appearance',refRunId:'run-a'},{evidenceId:'ev-2',clueId:'gate|appearance',refRunId:'run-a'}]);
  const verdicts=new Map([['ev-1|building|appearance','same'],['ev-2|gate|appearance','unsure']]);
  const b=assignClues(a.place,'run-b',second,{riskOf,verdicts});
  assert.deepEqual(b.evidence.map(entry=>[entry.placeClueId,entry.seenBefore]),[['road|appearance',true],['building|appearance',true],['gate|appearance#2',false]]);
  // Never asked counts like unsure. Without riskOf nothing is checked.
  assert.deepEqual(assignClues(a.place,'run-b',second,{riskOf}).evidence.map(entry=>entry.placeClueId),['road|appearance','building|appearance#2','gate|appearance#2']);
  assert.deepEqual(assignClues(a.place,'run-b',second).evidence.map(entry=>entry.placeClueId),['road|appearance','building|appearance','gate|appearance']);
  // A third photo is compared with both gates; a photo run again asks nothing and keeps its clues.
  assert.deepEqual(pendingChecks(b.place,'run-c',[item('ev-0','gate')],riskOf).map(check=>[check.clueId,check.refRunId]),[['gate|appearance','run-a'],['gate|appearance#2','run-b']]);
  assert.deepEqual(assignClues(b.place,'run-c',[item('ev-0','gate')],{riskOf,verdicts:new Map([['ev-0|gate|appearance#2','same']])}).evidence[0].placeClueId,'gate|appearance#2');
  assert.deepEqual(pendingChecks(b.place,'run-b',second,riskOf),[]);
  assert.deepEqual(assignClues(b.place,'run-b',second,{riskOf}).evidence,b.evidence);
  // The language or the viewpoint of a photo is not an object: never asked about, however high its clue.
  const scene=assignClues(null,'run-a',[item('ev-0','scene','layout')],{riskOf:()=>'high'});
  assert.deepEqual(pendingChecks(scene.place,'run-b',[item('ev-0','scene','layout')],()=>'high'),[]);
  assert.equal(assignClues(scene.place,'run-b',[item('ev-0','scene','layout')],{riskOf:()=>'high'}).evidence[0].seenBefore,true);
  assert.deepEqual(parseCheckAnswer('```json\n{"1":"same","2":"different"}\n```',2),['same','different']);
  assert.throws(()=>parseCheckAnswer('{"1":"same"}',2),/CHECK_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseCheckAnswer('{"1":"maybe"}',1),/CHECK_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseCheckAnswer('same',1),/CHECK_ANSWER_INVALID/);

  // The step: one call per earlier photo, both photos in one image, the verdicts kept on the record.
  const clue=(id,detail,risk)=>({id,category:'c',detail,rule:{class:'structure',unit:risk==='high'?'point':'country',situation:'',basis:''}});
  const runs=new Map(),places=new Map(),calls=[];
  const store={getRun:id=>runs.get(id),getPlace:name=>places.get(name)??null,savePlace:place=>{places.set(place.name,structuredClone(place));return place;},saveRun:run=>{runs.set(run.id,run);return run;},image:id=>Buffer.from(id)};
  const record=(id,subject)=>({id,clues:[clue('clue-0',`${subject} seen in ${id}`,'high')],evidence:[item('ev-0',subject)],modelCalls:[],errors:[]});
  const stage={model:'m',reasoningEffort:null},compose=async(left,right)=>Buffer.concat([left,right]);
  const llm=answer=>async request=>{calls.push(request);if(answer===null)throw Object.assign(new Error('HANDOFF_PENDING'),{handoff:{id:'h1',directory:'d'}});return {text:answer,raw:{responseId:`r${calls.length}`}};};
  await assignRunClues({store,run:record('run-a','building'),place:'p',stage,llm:llm('{}'),compose});
  assert.equal(calls.length,0);                                   // nothing known yet: nothing to ask
  const waiting=await assignRunClues({store,run:record('run-b','building'),place:'p',stage,llm:llm(null),compose});
  assert.equal(waiting.pending.stage,'placeCheck');assert.equal(waiting.place,undefined);assert.equal(places.get('p').clues[0].runIds.length,1);
  const done=await assignRunClues({store,run:record('run-b','building'),place:'p',stage,llm:llm('{"1":"different"}'),compose});
  assert.equal(calls.at(-1).imageBytes.toString(),'run-arun-b');assert.match(calls.at(-1).text,/building seen in run-a[\s\S]*building seen in run-b/);
  assert.deepEqual([done.evidence[0].placeClueId,done.evidence[0].seenBefore],['building|appearance#2',false]);
  assert.deepEqual(done.placeChecks.checks,[{evidenceId:'ev-0',clueId:'building|appearance',refRunId:'run-a',verdict:'different'}]);
  const again=await assignRunClues({store,run:structuredClone(done),place:'p',stage,llm:llm(null),compose});
  assert.deepEqual(again.placeChecks.checks,done.placeChecks.checks);assert.equal(again.pending,undefined);
  const third=await assignRunClues({store,run:record('run-c','building'),place:'p',stage,llm:llm('{"1":"same"}'),compose});
  assert.deepEqual([third.evidence[0].placeClueId,third.evidence[0].seenBefore],['building|appearance',true]);
  const failed=await assignRunClues({store,run:record('run-d','building'),place:'p',stage,llm:llm('nonsense'),compose});
  assert.equal(failed.errors[0].code,'CHECK_ANSWER_INVALID');assert.equal(failed.place,undefined);
});
