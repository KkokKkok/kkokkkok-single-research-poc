import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePoints,pointTargets,pointClues,pointPrompt,POINT_SOURCE } from '../lib/paper-point.mjs';
import { pointRunClues } from '../lib/paper-runner.mjs';
import { riskLabels } from '../lib/paper-risk.mjs';
import { displayRegions } from '../lib/paper-preview.mjs';
import { maskableRegions } from '../lib/paper-masks.mjs';
import { viewerData } from '../lib/paper-viewer.mjs';

const low={class:'view',unit:'city',risk:'low'};
const clue=(id,detail,extra={})=>({id,category:'c',detail,taxonomy:{number:1,name:'Towers And Masts'},rule:low,textTargets:[],objectTargets:[],regions:[],localization:'unlocalized',...extra});
// clue-0 and clue-1 form a combination; the detector found clue-0 only. clue-2 quotes text, clue-3 is in no inference.
const record=()=>({id:'run-1',status:'classified',image:{width:8,height:6},predictions:[],modelCalls:[],errors:[],regions:{version:'x'},masks:{version:'m'},
  rules:{combinations:[{id:'combo-0',type:'B2',clueIds:['clue-0','clue-1','clue-2'],unit:'point',risk:'high',reason:'r'}]},
  clues:[clue('clue-0','A gate',{regions:[{kind:'object',source:'grounding_dino',bbox:[0.1,0.1,0.3,0.3],query:'gate',score:0.6}],localization:'proposed'}),
    clue('clue-1','A red-and-white tower on the ridge'),clue('clue-2','Sign reads "CAFE"',{textTargets:['CAFE']}),clue('clue-3','A tree')]});
const reply=boxes=>'```json\n'+JSON.stringify(boxes)+'\n```';

test('only a clue used in an inference, without text and without a drawn region, is asked about',()=>{
  assert.deepEqual(pointTargets(record()).map(item=>item.id),['clue-1']);
  // A detector box too weak to be drawn does not count as found.
  const weak=record();weak.clues[0].regions[0].score=0.2;
  assert.deepEqual(pointTargets(weak).map(item=>item.id),['clue-0','clue-1']);
  assert.ok(pointPrompt(pointTargets(record())).includes('clue-1: A red-and-white tower on the ridge'));
  assert.deepEqual(parsePoints(reply({a:[0.1,0.2,0.3,0.4],b:null,c:[0.5,0.2,0.3,0.4],d:[0,0,1,0.9],e:'x'}),['a','b','c','d','e','f']),{a:[0.1,0.2,0.3,0.4],b:null,c:null,d:null,e:null,f:null});
  assert.throws(()=>parsePoints('no json',['a']),/POINT_ANSWER_INVALID/);
});

test('the pointed box becomes a stand-in region that is drawn, masked and told apart',async()=>{
  const run=record(),sent=[];
  const summary=await pointClues({bytes:Buffer.from('i'),run,model:'m',llm:async request=>{sent.push(Boolean(request.imageBytes));return {text:reply({'clue-1':[0.6,0.1,0.7,0.4]}),raw:{}};}});
  assert.deepEqual([summary.clues,summary.pointed,sent],[1,1,[true]]);
  const region=run.clues[1].regions[0];
  assert.deepEqual([region.source,region.kind,region.verified,region.score,region.bbox,run.clues[1].localization],[POINT_SOURCE,'object',false,null,[0.6,0.1,0.7,0.4],'proposed']);
  assert.deepEqual(displayRegions(run.clues[1]),[region]);
  assert.ok(maskableRegions(run).includes(region));
  assert.deepEqual([riskLabels(run).clues['clue-0'].locatedBy,riskLabels(run).clues['clue-1'].locatedBy],['detector','model']);
  const shown=viewerData([{run,title:'사진 1'}]).photos[0].clues[1];
  assert.deepEqual([shown.locatedBy,shown.regions[0].kind,shown.regions[0].standIn,shown.regions[0].score,shown.regions[0].shown],['model','o',true,null,true]);
});

test('the step runs once per record, drops the old masks, and waits for a hand-off answer',async()=>{
  const store={image:()=>Buffer.from('i'),saveRun:run=>run};
  let asked=0;const llm=async()=>{asked++;return {text:reply({'clue-1':[0.6,0.1,0.7,0.4]}),raw:{responseId:`r${asked}`}};};
  const done=await pointRunClues({store,run:record(),stage:{model:'m',transport:'handoff'},llm});
  assert.deepEqual([done.regions.pointing.pointed,done.regions.pointing.transport,done.masks,asked],[1,'handoff',undefined,1]);
  await pointRunClues({store,run:done,stage:{model:'m'},llm});assert.equal(asked,1);
  // Forced: the earlier stand-in is dropped first, so the clue is asked about again and has one box.
  const again=await pointRunClues({store,run:done,stage:{model:'m'},llm,force:true});
  assert.deepEqual([asked,again.clues[1].regions.length],[2,1]);
  const nothing=await pointRunClues({store,run:{...record(),rules:{combinations:[]}},stage:{model:'m'},llm});
  assert.deepEqual([nothing.regions.pointing.clues,nothing.masks.version,asked],[0,'m',2]);
  const parked=await pointRunClues({store,run:record(),stage:{model:'m'},llm:async()=>{throw Object.assign(new Error('HANDOFF_PENDING'),{handoff:{id:'h',directory:'d'}});}});
  assert.deepEqual([parked.pending.stage,parked.regions.pointing,parked.errors.length],['cluePoint',undefined,0]);
  const unlinked=await pointRunClues({store,run:{...record(),regions:null},stage:{model:'m'},llm});assert.equal(asked,2);assert.equal(unlinked.regions,null);
});
