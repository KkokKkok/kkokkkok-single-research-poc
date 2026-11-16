import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../lib/store.mjs';
import { sharp } from '../lib/config.mjs';
import { prepareImage } from '../lib/adapters.mjs';
import { discoverySchema,ocrReviewSchema,reconcileOcrBatch,verifyOcrCoverage,verifyProposalCoverage,cropPixels,jsonSchema } from '../lib/contracts.mjs';
import { runPipeline,assembleCues } from '../lib/pipeline.mjs';
import { createApp } from '../server.mjs';

const cue=(overrides={})=>({kind:'non_text',category:'Architectural Details',nameKo:'아치형 창문',observationKo:'아치형 창문이 보임',geographicRelevanceKo:'외관 비교에 쓸 수 있음',regionDescriptionKo:'왼쪽',scope:'object',visibleText:null,surface:'fixed',visibility:'clear',detectorQueryEn:'arched building window',limitationsKo:'지역적 고유성 미검증',...overrides});
const discovery={cues:[cue(),cue({kind:'text',category:'Sign Text',nameKo:'상호',observationKo:'상호 일부',visibleText:'TEST',detectorQueryEn:null}),cue({nameKo:'배경 배열',scope:'scene',detectorQueryEn:null})],coverageLimited:false,limitationsKo:[]};
const ocr={engine:'PaddleOCR',version:'fixture',coordinateSpace:'analysis-normalized',lines:[{id:'ocr-0',text:'TEST',score:.9,polygon:[[.1,.1],[.5,.1],[.5,.3],[.1,.3]]}]};
const group={lineIds:['ocr-0'],disposition:'candidate',category:'Sign Text',nameKo:'상호',observationKo:'TEST가 보임',geographicRelevanceKo:'검색 가능한 문자열',regionDescriptionKo:'간판',correctedText:null,surface:'fixed',visibility:'clear',limitationsKo:'유일성 미검증',relatedDiscoveryIndexes:[1]};
function fakeAdapters({ocrFail=false}={}){return {
  async vlm({schema,content,onRaw}){let out;if(schema===discoverySchema)out=discovery;else if(schema===ocrReviewSchema)out={groups:[group],limitationsKo:[]};else out={checks:content.filter(c=>c.type==='input_text').flatMap(c=>{let p;try{p=JSON.parse(c.text);}catch{return [];}return p.proposalId?[{proposalId:p.proposalId,verdict:'supported',evidenceKo:'crop에 관찰 근거가 있음'}]:[];})};onRaw({rawOutputText:JSON.stringify(out),responseId:'fixture',responseModel:'fixture',usage:null});return structuredClone(out);},
  async ocr(){if(ocrFail)throw new Error('OFFLINE');return structuredClone(ocr);},
  async detect(bytes,queries){return {requests:queries.map(q=>({...q,detections:[{id:`d-${q.cueId}`,label:q.query,score:.8,bbox:[.2,.3,.6,.7]}]}))};},
  async crop(bytes){return bytes;}
};}
async function sample(){return prepareImage(await sharp({create:{width:160,height:120,channels:3,background:'#e4dccd'}}).jpeg().toBuffer());}
function temporary(){return mkdtempSync(resolve(tmpdir(),'cue-lab-test-'));}
function cleanup(directory){const normalized=resolve(directory);if(!normalized.startsWith(resolve(tmpdir())+'\\cue-lab-test-')&&!normalized.startsWith(resolve(tmpdir())+'/cue-lab-test-'))throw new Error('Unexpected cleanup target');rmSync(normalized,{recursive:true,force:true});}
test('open taxonomy retains more than 12 observations and unseen categories',()=>{assert.equal(discoverySchema.parse({...discovery,cues:Array.from({length:20},()=>cue({category:'Previously Unlisted Fixture'}))}).cues.length,20);assert.ok(jsonSchema(discoverySchema).properties.cues);});
test('OCR unknown, duplicate, omitted and non-text association IDs are rejected',()=>{
  assert.throws(()=>verifyOcrCoverage({groups:[]},ocr,discovery));
  assert.throws(()=>verifyOcrCoverage({groups:[group,group]},ocr,discovery));
  assert.throws(()=>verifyOcrCoverage({groups:[{...group,lineIds:['unknown']}]},ocr,discovery));
  assert.throws(()=>verifyOcrCoverage({groups:[{...group,relatedDiscoveryIndexes:[0]}]},ocr,discovery));
  assert.doesNotThrow(()=>verifyOcrCoverage({groups:[group]},ocr,discovery));
});
test('verification IDs and normalized crop geometry are checked',()=>{
  assert.throws(()=>verifyProposalCoverage({checks:[{proposalId:'fake'}]},[{id:'real'}]));
  assert.throws(()=>verifyProposalCoverage({checks:[]},[{id:'real'}]));
  assert.deepEqual(cropPixels([.1,.2,.4,.6],1000,500),{left:100,top:100,width:300,height:200});
  assert.throws(()=>cropPixels([.9,.2,.2,.5],100,100));
});
test('OCR batch duplicates and missing lines are preserved as uncertain, never silently accepted',()=>{
  const output=reconcileOcrBatch({groups:[group,group],limitationsKo:[]},ocr.lines,discovery);
  assert.equal(output.groups.length,1);assert.equal(output.groups[0].disposition,'uncertain');assert.equal(output.groups[0].correctedText,null);assert.deepEqual(output.groups[0].relatedDiscoveryIndexes,[]);
  const missing=reconcileOcrBatch({groups:[],limitationsKo:[]},ocr.lines,discovery);assert.equal(missing.groups[0].lineIds[0],'ocr-0');
});
test('geographic irrelevance is distinct from incorrect spatial correspondence',()=>{
  const r={artifacts:{discovery:{cues:[]},ocr,ocr_review:{groups:[{...group,disposition:'irrelevant',relatedDiscoveryIndexes:[]}],reviewMode:'per_region_crops'}}};
  const [c]=assembleCues(r);assert.equal(c.disposition,'irrelevant');assert.equal(c.localization.status,'not_assessed');assert.equal(c.localization.proposals[0].verdict,'not_assessed');assert.ok(c.localization.proposals[0].bbox);
});
test('production OCR crop batches preserve every ID and directly record crop review evidence',async()=>{
  const dir=temporary(),s=new Store(dir);try{const p=await sample(),r=s.create(p.image,p.bytes,'fixture');const a=fakeAdapters();a.ocrContext=async()=>[];const original=a.vlm;a.vlm=async args=>{if(args.schema.shape?.groups){const out={groups:[group],limitationsKo:[]};args.onRaw({rawOutputText:JSON.stringify(out)});return args.schema.parse(out);}return original(args);};const out=await runPipeline(s,r.id,a);assert.equal(out.status,'completed');assert.equal(out.artifacts.ocr_review.reviewMode,'per_region_crops');assert.equal(out.cues.find(c=>c.id==='ocr-cue-0').localization.proposals[0].verificationSource,'ocr_crop_review');assert.equal(out.stages['verify_ocr-cue-0'],undefined);}finally{s.close();cleanup(dir);}
});
test('pipeline persists text/non-text cues, raw evidence, bbox, unlocalized scene and reloads',async()=>{
  const dir=temporary();let s=new Store(dir);try{const p=await sample();const r=s.create(p.image,p.bytes,'fixture');const output=await runPipeline(s,r.id,fakeAdapters());assert.equal(output.status,'completed');assert.equal(output.cues.length,4);assert.equal(output.cues[0].localization.status,'supported');assert.equal(output.cues[1].localization.proposals[0].source,'paddleocr');assert.equal(output.cues[2].localization.status,'unlocalized');assert.equal(output.cues[3].rawReadings[0].text,'TEST');assert.ok(output.artifacts.discovery_raw);assert.equal(output.cues[0].geoSpecificityVerified,false);s.close();s=new Store(dir);assert.equal(s.get(r.id).cues.length,4);}finally{s.close();cleanup(dir);}
});
test('OCR failure is partial; successful discovery and DINO are not rerun on retry',async()=>{
  const dir=temporary(),s=new Store(dir);try{const p=await sample();const r=s.create(p.image,p.bytes,'fixture');const a=await runPipeline(s,r.id,fakeAdapters({ocrFail:true}));assert.equal(a.status,'partial');assert.equal(a.cues[0].localization.status,'supported');const next=fakeAdapters();const realVlm=next.vlm;next.vlm=async args=>{assert.notEqual(args.schema,discoverySchema);return realVlm(args);};next.detect=()=>assert.fail('DINO rerun');const b=await runPipeline(s,r.id,next);assert.equal(b.status,'completed');assert.equal(b.cues.length,4);}finally{s.close();cleanup(dir);}
});
test('duplicate OCR groups are repaired once and both model responses remain in call history',async()=>{
  const dir=temporary(),s=new Store(dir);try{const p=await sample(),r=s.create(p.image,p.bytes,'fixture');const a=fakeAdapters();const call=a.vlm;let reviews=0;a.vlm=async args=>{if(args.schema===ocrReviewSchema&&reviews++===0){const out={groups:[group,group],limitationsKo:[]};args.onRaw({rawOutputText:JSON.stringify(out)});return out;}return call(args);};const out=await runPipeline(s,r.id,a);assert.equal(out.status,'completed');assert.equal(reviews,2);assert.ok(out.modelCalls.some(c=>c.stage==='ocr_review'));assert.ok(out.modelCalls.some(c=>c.stage==='ocr_review_repair'));}finally{s.close();cleanup(dir);}
});
test('server validates upload, rejects CSRF, exports JSON and preserves separate human review',async()=>{
  const dir=temporary();const app=createApp({directory:dir,adapters:fakeAdapters(),requireConfiguration:false});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;try{
    const config=await (await fetch(base+'/api/config')).json();assert.equal(config.apiKey,undefined);
    assert.equal((await fetch(base+'/api/analyses',{method:'POST',body:'x'})).status,403);
    const headers={'x-cue-token':config.token};assert.equal((await fetch(base+'/api/analyses',{method:'POST',headers,body:'not an image'})).status,400);
    const p=await sample();const upload=await fetch(base+'/api/analyses',{method:'POST',headers,body:p.bytes});assert.equal(upload.status,202);const {id}=await upload.json();let r;
    for(let i=0;i<100;i++){r=await (await fetch(base+`/api/analyses/${id}`)).json();if(r.status==='completed')break;await new Promise(r=>setTimeout(r,20));}assert.equal(r.status,'completed');
    const raw=r.artifacts.discovery_raw.rawOutputText;
    const review=await fetch(base+`/api/analyses/${id}/reviews`,{method:'POST',headers,body:JSON.stringify({cueId:r.cues[0].id,status:'accepted',note:'사람 검토',bbox:[.1,.1,.4,.4],expectedUpdatedAt:r.updatedAt})});assert.equal(review.status,200);
    const saved=await review.json();assert.equal(saved.artifacts.discovery_raw.rawOutputText,raw);assert.equal(saved.humanReviews[r.cues[0].id].status,'accepted');
    const exported=await (await fetch(base+`/api/analyses/${id}/export`)).json();assert.equal(exported.image.coordinateSpace,'analysis-normalized');
    assert.equal((await fetch(base+'/api/config',{headers:{Origin:'https://example.com'}})).status,403);
    assert.equal((await fetch(base+'/private-data/cues.sqlite')).status,404);
  }finally{await app.close();cleanup(dir);}
});

