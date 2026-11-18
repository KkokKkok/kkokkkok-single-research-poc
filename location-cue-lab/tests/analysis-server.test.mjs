import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharp } from '../lib/config.mjs';
import { createAnalysisApp } from '../analysis-server.mjs';
import { paperStages,regionStage,ruleStage } from '../lib/paper-llm.mjs';

const fence='```',KEY='test-key';
const stages=()=>{const env={OPENAI_MODEL:'fixture-model'};return {paper:paperStages(env),rules:ruleStage(env),regions:regionStage(env)};};
const photo=(background='#e4dccd')=>sharp({create:{width:160,height:120,channels:3,background}}).jpeg().toBuffer();
// Answers by step, told apart by the prompt. `fail` names a step whose answer is unusable.
function fakeLlm({fail=null}={}){
  const calls=[];
  const llm=async({text,imageBytes})=>{
    const step=text.includes('You judge how far each clue narrows')?'rules':text.includes('search phrases for an object detector')?'targets':text.includes('pieces of text that were read in this photo')?'hints':text.includes('clues that were written about this photo')?'point':'detector';
    calls.push(step);
    assert.equal(Boolean(imageBytes),['detector','hints','point'].includes(step));
    const answer=step===fail?'no answer':{
      detector:`List:\n${fence}python\ncandidate_categories = [\n"Signage"\n]\n${fence}\n\nThink: a sign and a gate.\n\nJson:\n${fence}json\n{"Signage": "Sign reads \\"CAFE ONE\\"", "Gate": "A red gate"}\n${fence}\n`,
      rules:`${fence}json\n${JSON.stringify({clues:{'clue-0':{class:'identifier',situation:'흔한 이름의 상호',basis:'같은 이름이 많을 수 있음',unit:'few'},'clue-1':{class:'structure',situation:'특징적인 문',basis:'비슷한 문이 있을 수 있음',unit:'few'}},combinations:[{type:'A1',clueIds:['clue-0','clue-1'],unit:'point',reason:'상호와 문이 함께 보임'}]})}\n${fence}`,
      targets:`${fence}json\n{"clue-0": ["sign"], "clue-1": ["red gate"]}\n${fence}`,
      hints:`${fence}json\n{}\n${fence}`,point:`${fence}json\n{}\n${fence}`,
    }[step];
    return {text:answer,raw:{responseId:`r-${calls.length}`,usage:null}};
  };
  llm.calls=calls;return llm;
}
const tools={
  ocr:async()=>({engine:'PaddleOCR',version:'fixture',coordinateSpace:'analysis-normalized',lines:[{id:'ocr-0',text:'CAFE ONE',score:0.9,polygon:[[0.1,0.2],[0.3,0.2],[0.3,0.25],[0.1,0.25]]}]}),
  detect:async(bytes,queries)=>({engine:'Grounding DINO',model:'fixture',revision:'r',requests:queries.map(query=>({cueId:query.cueId,query:query.query,detections:[{id:`${query.cueId}-0`,bbox:[0.5,0.5,0.8,0.9],score:0.7,label:query.query}]}))}),
  segment:async(bytes,boxes)=>({engine:'SAM',model:'fixture',revision:'r',masks:boxes.map(box=>({id:box.id,score:0.9,size:[2,4],counts:[1,2,5]}))}),
};
async function withApp(options,body){
  const directory=mkdtempSync(resolve(tmpdir(),'analysis-server-test-'));
  const app=createAnalysisApp({directory,apiKey:KEY,stages,tools,requireConfiguration:false,masks:true,allowedHosts:[],...options});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const send=(bytes,key,headers={})=>{const form=new FormData();form.append('photo',new Blob([bytes],{type:'image/jpeg'}),'photo.jpg');form.append('locationRole','capture');
    return fetch(`${base}/api/inspections`,{method:'POST',headers:{'X-Analysis-Api-Key':KEY,'Idempotency-Key':key,'X-Analysis-Consent':'true',...headers},body:form});};
  const read=id=>fetch(`${base}/api/inspections/${id}`,{headers:{'X-Analysis-Api-Key':KEY}});
  const settled=async id=>{for(let i=0;i<200;i++){const value=await (await read(id)).json();if(['completed','failed'].includes(value.status))return value;await new Promise(done=>setTimeout(done,20));}throw new Error('not settled');};
  try{await body({app,base,send,read,settled,directory});}finally{await app.close();rmSync(directory,{recursive:true,force:true});}
}

test('a photo sent the way the backend sends it comes back as a completed inspection',async()=>{
  const llm=fakeLlm();
  await withApp({llm},async({send,read,settled,base})=>{
    const key=randomUUID(),bytes=await photo();
    const accepted=await send(bytes,key);
    assert.equal(accepted.status,202);
    const first=await accepted.json();
    assert.equal(first.inspectionId,key);
    assert.ok(['queued','processing','completed'].includes(first.status));
    const done=await settled(key);
    assert.equal(done.status,'completed');
    assert.equal(done.inspectionId,key);
    assert.deepEqual(done.riskSummary,{score:null,level:'high'});
    assert.deepEqual(done.pipelineStages,{visualObservation:'completed',ocr:'completed',objectDetection:'completed'});
    assert.deepEqual(done.riskFactors.map(factor=>[factor.id,factor.type,factor.modelRisk,factor.bbox,factor.coordinateSpace]),
      [['clue-0','text','medium',[0.1,0.2,0.3,0.25],'analysis-normalized'],['clue-1','building','medium',[0.5,0.5,0.8,0.9],'analysis-normalized']]);
    assert.equal(done.riskFactors[0].title,'흔한 이름의 상호');
    assert.equal(done.riskFactors[0].regions[0].polygon.length,4);
    assert.deepEqual(done.riskFactors[1].regions[0].mask,{size:[2,4],counts:[1,2,5],score:0.9});
    assert.deepEqual(done.combinations.map(combo=>[combo.clueIds,combo.risk]),[[['clue-0','clue-1'],'high']]);
    // Nothing of the model's raw answers, the photo's hash or the settings leaves the server.
    assert.deepEqual(Object.keys(done).sort(),['combinations','error','image','inspectionId','mock','model','pipelineStages','pipelineVersion','progress','riskFactors','riskSummary','status','visualObservations']);
    assert.deepEqual(llm.calls,['detector','rules','targets']);
    // The same key and photo give the same inspection without another analysis; another photo is refused.
    const again=await send(bytes,key);
    assert.equal(again.status,202);
    assert.equal((await again.json()).status,'completed');
    assert.equal((await send(await photo('#102030'),key)).status,409);
    assert.equal(llm.calls.length,3);
    assert.equal((await fetch(`${base}/api/health`)).status,200);
  });
});

test('requests the backend would not send are refused',async()=>{
  await withApp({llm:fakeLlm()},async({send,read,base})=>{
    const bytes=await photo(),key=randomUUID();
    assert.equal((await send(bytes,key,{'X-Analysis-Api-Key':'wrong'})).status,401);
    assert.equal((await send(bytes,key,{'X-Analysis-Consent':'false'})).status,400);
    assert.equal((await send(bytes,'not-a-uuid')).status,400);
    assert.equal((await send(Buffer.from('not an image'),key)).status,415);
    assert.equal((await send(bytes,key,{Origin:'http://example.com'})).status,403);
    assert.equal((await read(randomUUID())).status,404);
    assert.equal((await read('nope')).status,400);
    assert.equal((await fetch(`${base}/api/inspections/${randomUUID()}`)).status,401);
    assert.equal((await fetch(`${base}/api/inspections`,{method:'POST',headers:{'X-Analysis-Api-Key':KEY,'Idempotency-Key':key,'X-Analysis-Consent':'true','Content-Type':'application/json'},body:'{}'})).status,415);
  });
  await withApp({llm:fakeLlm(),apiKey:''},async({send})=>{assert.equal((await send(await photo(),randomUUID())).status,503);});
});

test('a failed step ends the inspection as failed or as completed without boxes, and a deleted one is gone',async()=>{
  await withApp({llm:fakeLlm({fail:'detector'})},async({send,settled})=>{
    const key=randomUUID();await send(await photo(),key);
    const failed=await settled(key);
    assert.equal(failed.status,'failed');
    assert.ok(failed.error.message);
    assert.deepEqual(failed.riskFactors,[]);
  });
  // No region targets: the clues and their risks are still shown, without boxes, and the result is marked partial.
  await withApp({llm:fakeLlm({fail:'targets'})},async({send,read,settled,base,app})=>{
    const key=randomUUID();await send(await photo(),key);
    const done=await settled(key);
    assert.equal(done.status,'completed');
    assert.deepEqual(done.riskFactors.map(factor=>[factor.modelRisk,factor.bbox]),[['medium',null],['medium',null]]);
    assert.equal(done.pipelineStages.ocr,'failed');
    const removed=await fetch(`${base}/api/inspections/${key}`,{method:'DELETE',headers:{'X-Analysis-Api-Key':KEY}});
    assert.equal(removed.status,204);
    assert.equal((await read(key)).status,404);
    assert.equal(app.store.listRuns().length,0);
    assert.equal((await fetch(`${base}/api/inspections/${key}`,{method:'DELETE',headers:{'X-Analysis-Api-Key':KEY}})).status,204);
  });
});

test('a record a restart interrupted is taken up again when the server starts',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'analysis-server-test-'));
  try{
    // The first server never gets an answer; it is closed with the record still queued.
    let release;const stuck=new Promise(done=>{release=done;});
    const first=createAnalysisApp({directory,apiKey:KEY,stages,tools,requireConfiguration:false,llm:async()=>{await stuck;throw new Error('STOPPED');}});
    await new Promise(done=>first.server.listen(0,'127.0.0.1',done));
    const key=randomUUID(),form=new FormData();form.append('photo',new Blob([await photo()],{type:'image/jpeg'}),'photo.jpg');
    await fetch(`http://127.0.0.1:${first.server.address().port}/api/inspections`,{method:'POST',headers:{'X-Analysis-Api-Key':KEY,'Idempotency-Key':key,'X-Analysis-Consent':'true'},body:form});
    const run=first.store.getRun(key);
    release();await first.close();
    // Put back as the interrupted server left it.
    run.status='queued';run.errors=[];run.service={...run.service,state:'processing'};first.store.saveRun(run);
    const llm=fakeLlm(),second=createAnalysisApp({directory,apiKey:KEY,stages,tools,requireConfiguration:false,llm});
    await new Promise(done=>second.server.listen(0,'127.0.0.1',done));
    try{
      let value;
      for(let i=0;i<200;i++){value=second.store.getRun(key);if(value.service.state==='completed')break;await new Promise(done=>setTimeout(done,20));}
      assert.equal(value.service.state,'completed');
      assert.equal(value.clues.length,2);
    }finally{await second.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
