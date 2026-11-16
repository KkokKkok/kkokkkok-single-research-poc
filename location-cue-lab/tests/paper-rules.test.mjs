import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleAnswer,judgeClues,ruleOf,ruleMarks,rulePrompt,linkingTierOf,linkingTierFor,usedClueIds,RULE_VERSION } from '../lib/paper-rules.mjs';
import { judgeRunRules } from '../lib/paper-runner.mjs';
import { viewerData,VIEWER_HTML } from '../lib/paper-viewer.mjs';

const clue=(id,detail,name='Commercial Signage')=>({id,category:'c',detail,taxonomy:{number:1,name}});
const clues=[clue('clue-0','Station sign reads "합정"'),clue('clue-1','A CU convenience store sign'),clue('clue-2','A Starbucks across the street'),clue('clue-3','Korean text on signs','Written Language Script'),clue('clue-4','A bank logo')];
const entry=(cls,unit,basis='근거')=>({class:cls,situation:'상황',basis,unit});
const answer=(judged,combinations=[])=>'생각...\n```json\n'+JSON.stringify({clues:judged,combinations})+'\n```';
const judged={'clue-0':entry('identifier','point'),'clue-1':entry('chain','city'),'clue-2':entry('chain','city'),'clue-3':entry('regional','few'),'clue-4':entry('chain','city')};

test('the risk follows the unit, and a regional-style clue is always low',()=>{
  const result=parseRuleAnswer(answer(judged),clues.map(item=>item.id));
  assert.deepEqual(Object.values(result.clues).map(item=>[item.unit,item.risk]),[['point','high'],['city','low'],['city','low'],['country','low'],['city','low']]);
  assert.deepEqual(result.clues['clue-0'],{class:'identifier',situation:'상황',basis:'근거',unit:'point',risk:'high'});
  assert.equal(parseRuleAnswer(answer({...judged,'clue-1':entry('chain','few')}),clues.map(item=>item.id)).clues['clue-1'].risk,'medium');
  // A clue left out, an unknown class or unit, a missing basis, an unknown clue: the answer is refused.
  const ids=clues.map(item=>item.id),{['clue-4']:dropped,...missing}=judged;
  assert.throws(()=>parseRuleAnswer(answer(missing),ids),/RULE_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseRuleAnswer(answer({...judged,'clue-1':entry('brand','city')}),ids),/RULE_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseRuleAnswer(answer({...judged,'clue-1':entry('chain','street')}),ids),/RULE_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseRuleAnswer(answer({...judged,'clue-1':entry('chain','city','  ')}),ids),/RULE_ANSWER_INCOMPLETE/);
  assert.throws(()=>parseRuleAnswer(answer({...judged,'clue-9':entry('chain','city')}),ids),/RULE_ANSWER_UNKNOWN_CLUE/);
  assert.throws(()=>parseRuleAnswer('no json here',ids),/RULE_ANSWER_INVALID/);
});

test('a combination is kept only when the sheet admits it',()=>{
  const ids=clues.map(item=>item.id),combo=(type,members,unit,reason='맞은편에 함께 보임')=>({type,clueIds:members,unit,reason});
  const result=parseRuleAnswer(answer(judged,[
    combo('A1',['clue-1','clue-2'],'few'),                 // two chains: narrower than either
    combo('A2',['clue-1','clue-2','clue-4'],'point'),
    combo('A1',['clue-0','clue-1'],'point'),               // a member is already a point
    combo('A1',['clue-3','clue-1'],'few'),                 // a regional-style clue is the other's premise
    combo('A1',['clue-1','clue-2'],'city'),                // not narrower than its members
    combo('A1',['clue-1','clue-1'],'few'),                 // one clue twice
    combo('A1',['clue-1','clue-8'],'few'),                 // an unknown clue
    combo('A1',['clue-1','clue-2'],'few',''),              // no reason given
    combo('Z9',['clue-2','clue-4'],'few'),                 // a type the sheet does not list
  ]),ids);
  assert.deepEqual(result.combinations.map(item=>[item.id,item.type,item.clueIds.length,item.unit,item.risk]),[['combo-0','A1',2,'few','medium'],['combo-1','A2',3,'point','high'],['combo-2','other',2,'few','medium']]);
  assert.deepEqual(result.rejected.map(item=>item.code),['MEMBER_ALREADY_POINT','MEMBER_REGIONAL','NOT_NARROWER','MEMBERS_INVALID','MEMBERS_INVALID','INCOMPLETE']);
});

test('the model is given the clue text only and is asked again after a bad answer',async()=>{
  const prompt=rulePrompt([{...clues[0],regions:[{bbox:[0,0,1,1]}],textTargets:['합정']}]);
  assert.ok(prompt.includes('"detail": "Station sign reads \\"합정\\""')&&!prompt.includes('bbox')&&!prompt.includes('textTargets'));
  assert.ok(prompt.includes('Never name or guess the actual place'));
  const calls=[],replies=['not json',answer(judged,[{type:'A1',clueIds:['clue-1','clue-2'],unit:'few',reason:'함께 보임'}])];
  const result=await judgeClues({clues,model:'m',llm:async request=>{calls.push(request.attempt);return {text:replies.shift(),raw:{responseId:`r${request.attempt}`}};}});
  assert.deepEqual(calls,[1,2]);
  assert.deepEqual([result.summary.version,result.summary.attempts,result.summary.combinations.length],[RULE_VERSION,2,1]);
  assert.deepEqual(result.clues.map(item=>item.rule.risk),['high','low','low','low','low']);
  await assert.rejects(judgeClues({clues,model:'m',llm:async()=>({text:'nope',raw:{}})}),/RULE_ANSWER_INVALID/);
});

test('a record is judged once, and a failure is recorded without touching its clues',async()=>{
  const saved=[],store={saveRun:run=>{saved.push(run.rules?.version??null);return run;}};
  const run={id:'r',status:'classified',clues:clues.map(item=>({...item})),modelCalls:[],errors:[]};
  let asked=0;const llm=async()=>{asked++;return {text:answer(judged),raw:{responseId:`r${asked}`}};};
  const done=await judgeRunRules({store,run,stage:{model:'m',reasoningEffort:null},llm});
  assert.deepEqual([done.rules.version,done.rules.stage.model,done.clues[0].rule.unit,done.modelCalls.at(-1).stage],[RULE_VERSION,'m','point','rules']);
  await judgeRunRules({store,run:done,stage:{model:'m'},llm});assert.equal(asked,1);
  await judgeRunRules({store,run:done,stage:{model:'m'},llm,force:true});assert.equal(asked,2);
  const failed=await judgeRunRules({store,run:{id:'f',status:'extracted',clues:[clue('clue-0','d')],modelCalls:[],errors:[]},stage:{model:'m'},llm:async()=>({text:'x',raw:{}})});
  assert.deepEqual([failed.errors[0].stage,failed.errors[0].code,failed.rules,failed.clues[0].rule],['rules','RULE_ANSWER_INVALID',undefined,undefined]);
  const handoff=Object.assign(new Error('HANDOFF_PENDING'),{handoff:{id:'h1',directory:'d'}});
  const parked=await judgeRunRules({store,run:{id:'p',status:'extracted',clues:[clue('clue-0','d')],modelCalls:[],errors:[]},stage:{model:'m'},llm:async()=>{throw handoff;}});
  assert.deepEqual([parked.pending.stage,parked.pending.id,parked.errors.length],['rules','h1',0]);
});

test('a clue not judged yet shows its category default, marked as such',()=>{
  assert.deepEqual(['Commercial Signage','Traffic Signage','Climate Indicators'].map(name=>{const mark=ruleOf(clue('c','d',name));return [mark.unit,mark.risk,mark.judged,mark.class];}),
    [['point','high',false,null],['city','low',false,null],['country','low',false,null]]);
  assert.equal(ruleOf({id:'c',detail:'d',taxonomy:null}).unit,'point');   // unknown is not the same as harmless
  const mark=ruleOf({...clue('c','d','Climate Indicators'),rule:{class:'identifier',situation:'s',basis:'b',unit:'few'}});
  assert.deepEqual([mark.unit,mark.risk,mark.judged],['few','medium',true]);
  // Linking follows the judgement: high and medium are looked for by both tools, low by text only, regional not at all.
  assert.deepEqual([{risk:'high',class:'identifier'},{risk:'medium',class:'view'},{risk:'low',class:'chain'},{risk:'low',class:'regional'}].map(rule=>linkingTierOf({rule})),['A','A','B','C']);
  assert.equal(linkingTierOf({}),null);
  // A low clue that is part of a combination, or that a map search confirmed, is looked for all the same.
  const low=id=>({...clue(id,'d','Climate Indicators'),rule:{class:'view',unit:'city',risk:'low'}});
  const used={clues:[low('clue-0'),low('clue-1'),low('clue-2'),low('clue-3')],rules:{combinations:[{id:'combo-0',clueIds:['clue-0','clue-1']}]},placeSearches:[{query:'q',clueIds:['clue-2'],topWithinRadius:true,topDistanceM:9}]};
  assert.deepEqual([...usedClueIds(used)].sort(),['clue-0','clue-1','clue-2']);
  assert.deepEqual(used.clues.map(linkingTierFor(used)),['A','A','A','B']);
});

test('the viewer data carries the unit, the risk and the combinations in place of tiers and labels',()=>{
  const parsed=parseRuleAnswer(answer(judged,[{type:'A1',clueIds:['clue-1','clue-2'],unit:'few',reason:'맞은편에 함께 보임'}]),clues.map(item=>item.id));
  const run={id:'run-1',image:{width:8,height:6},predictions:[],regions:null,clues:clues.map(item=>({...item,rule:parsed.clues[item.id]})),rules:{version:RULE_VERSION,combinations:parsed.combinations},
    placeSearches:[{query:'합정',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:12}]};
  assert.deepEqual(ruleMarks(run).counts,{high:1,medium:0,low:4});
  const photo=viewerData([{run,title:'사진 1'}],{internal:false}).photos[0];
  assert.deepEqual(photo.risk,{high:1,medium:0,low:4,judged:true});
  assert.deepEqual(photo.combinations.map(item=>[item.type,item.clueNs,item.unit,item.risk,Object.keys(item).some(key=>key.endsWith('Ko'))]),[['A1',[2,3],'few','medium',false]]);
  assert.deepEqual(photo.clues.map(item=>item.combinations),[[],['combo-0'],['combo-0'],[],[]]);
  assert.deepEqual(photo.clues[0].rule,{class:'identifier',situation:'상황',basis:'근거',unit:'point',risk:'high',judged:true});
  for(const field of ['tier','tierNote','label','labelKo','reason'])assert.equal(field in photo.clues[0],false);
  // What a search measured stays beside the risk, not in it.
  assert.deepEqual([photo.clues[0].confirmed,photo.clues[1].confirmed,photo.measured.confirmed,photo.measured.searched],[true,false,1,true]);
  // A record without a judgement is listed with category defaults and no combinations.
  const bare=viewerData([{run:{...run,rules:undefined,clues:clues.map(item=>({...item}))},title:'사진 1'}]).photos[0];
  assert.deepEqual([bare.risk.judged,bare.combinations.length,bare.clues[3].rule.unit,bare.clues[3].rule.judged],[false,0,'country',false]);
  assert.ok(VIEWER_HTML.includes('UNIT_KO[clue.rule.unit]')&&!/clue\.tier|clue\.label\b/.test(VIEWER_HTML));
});
