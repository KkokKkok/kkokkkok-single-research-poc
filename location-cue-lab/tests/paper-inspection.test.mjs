import test from 'node:test';
import assert from 'node:assert/strict';
import { toInspection,inspectionStatus,mainRegion,factorType } from '../lib/paper-inspection.mjs';

const rule=(cls,unit,risk)=>({class:cls,situation:`${cls} 상황`,basis:`${cls} 근거`,unit,risk});
const run=()=>({schemaVersion:'paper-clues-v2',id:'3d435cc9-bbab-4673-9517-21dd69bfc902',status:'classified',image:{width:768,height:1024},
  stages:{detector:{model:'m'}},detector:{},errors:[],regions:{version:'paper-regions-v1'},
  rules:{version:'kkokkkok-rules-2026-11-17',combinations:[{id:'combo-0',type:'A1',clueIds:['clue-1','clue-2'],unit:'point',risk:'high',reason:'함께 보면 한 곳'}]},
  clues:[
    // Quotes text: only the OCR line counts, the detector box does not.
    {id:'clue-0',category:'Signage',detail:'Sign reads "CAFE ONE"',textTargets:['CAFE ONE'],rule:rule('identifier','few','medium'),regions:[
      {id:'d0',source:'grounding_dino',kind:'object',bbox:[0,0,0.9,0.9],score:0.9},
      {id:'t0',source:'paddleocr',kind:'text',bbox:[0.1,0.2,0.3,0.25],polygon:[[0.1,0.2],[0.3,0.2],[0.3,0.25],[0.1,0.25]],score:0.8}]},
    {id:'clue-1',category:'Tower',detail:'A tower far away',textTargets:[],rule:rule('view','city','low'),regions:[
      {id:'p0',source:'model_point',kind:'object',bbox:[0.4,0.1,0.5,0.4],score:1,verified:false},
      {id:'d1',source:'grounding_dino',kind:'object',bbox:[0.42,0.1,0.5,0.4],score:0.5,mask:{size:[2,4],counts:[1,2,5],score:0.9}}]},
    {id:'clue-2',category:'Gate',detail:'A gate',textTargets:[],rule:rule('structure','few','medium'),regions:[]},
    {id:'clue-3',category:'Season',detail:'Winter',rule:rule('nature','country','low')}]});

test('a finished record becomes a completed inspection the backend and the app can read',()=>{
  const out=toInspection(run());
  assert.equal(out.inspectionId,'3d435cc9-bbab-4673-9517-21dd69bfc902');
  assert.equal(out.status,'completed');
  assert.deepEqual(out.riskSummary,{score:null,level:'high'});
  assert.deepEqual(out.pipelineStages,{visualObservation:'completed',ocr:'completed',objectDetection:'completed'});
  assert.deepEqual(out.riskFactors.map(factor=>[factor.id,factor.type,factor.modelRisk,factor.unit]),
    [['clue-0','text','medium','few'],['clue-1','building','low','city'],['clue-2','building','medium','few'],['clue-3','object','low','country']]);
  for(const factor of out.riskFactors){
    assert.equal(factor.coordinateSpace,'analysis-normalized');
    assert.notEqual(factor.title,factor.type);
  }
  assert.equal(out.riskFactors[0].title,'identifier 상황');
  assert.equal(out.riskFactors[0].modelReason,'identifier 근거');
  assert.equal(out.riskFactors[0].text,'CAFE ONE');
  assert.deepEqual(out.combinations.map(combo=>[combo.id,combo.risk,combo.unitLabel]),[['combo-0','high','지점 하나']]);
});

test('a factor carries one box, a tool-confirmed region first, and lists all trusted regions',()=>{
  const out=toInspection(run());
  assert.deepEqual(out.riskFactors[0].bbox,[0.1,0.2,0.3,0.25]);
  assert.deepEqual(out.riskFactors[0].regions.map(region=>region.id),['t0']);
  assert.equal(out.riskFactors[0].regions[0].polygon.length,4);
  assert.deepEqual(out.riskFactors[1].bbox,[0.42,0.1,0.5,0.4]);
  assert.deepEqual(out.riskFactors[1].regions.map(region=>[region.id,region.verified]),[['p0',false],['d1',true]]);
  assert.deepEqual(out.riskFactors[1].regions[1].mask,{size:[2,4],counts:[1,2,5],score:0.9});
  assert.equal(out.riskFactors[2].bbox,null);
  assert.equal(out.riskFactors[3].bbox,null);
  assert.equal(toInspection(run(),{masks:false}).riskFactors[1].regions[1].mask,undefined);
  assert.equal(mainRegion({regions:[{kind:'object',bbox:[0.5,0.5,0.4,0.6]}]}),null);
  // The lines OCR split one quoted text into are covered by one box; another quoted text is not joined.
  const line=(bbox,quoted,score)=>({kind:'text',source:'paddleocr',bbox,quoted,score});
  assert.deepEqual(mainRegion({textTargets:['A B','C'],regions:[line([0.1,0.2,0.3,0.3],'A B',0.9),line([0.35,0.21,0.5,0.31],'A B',0.99),line([0.7,0.7,0.8,0.8],'C',0.5)]}).bbox,[0.1,0.2,0.5,0.31]);
  assert.equal(factorType({textTargets:[],rule:{class:'chain'}}),'object');
});

test('status follows the steps, and an unjudged clue has no risk',()=>{
  const queued={...run(),status:'queued',clues:[],rules:undefined,regions:undefined,detector:null};
  assert.equal(inspectionStatus(queued),'queued');
  assert.equal(toInspection(queued).riskSummary.level,'pending');
  const extracted={...run(),rules:undefined,regions:undefined};
  for(const clue of extracted.clues)delete clue.rule;
  assert.equal(inspectionStatus(extracted),'processing');
  const partial=toInspection(extracted,{status:'completed'});
  assert.equal(partial.riskSummary.level,'not_assessed');
  assert.ok(partial.riskFactors.every(factor=>factor.modelRisk===null&&factor.modelReason===null));
  assert.deepEqual(partial.combinations,[]);
  const failed=toInspection({...run(),status:'failed',clues:[],rules:undefined,regions:undefined,detector:null,errors:[{stage:'detector'}]});
  assert.equal(failed.status,'failed');
  assert.ok(failed.error.message);
  assert.equal(failed.pipelineStages.ocr,'failed');
  assert.equal(inspectionStatus({...run(),clues:[],rules:undefined,regions:undefined}),'completed');
});
