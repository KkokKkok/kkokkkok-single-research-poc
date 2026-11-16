import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { prepareImage } from '../lib/adapters.mjs';
import { runPipeline } from '../lib/pipeline.mjs';

const path=process.argv[2];
if(!path||!process.env.OPENAI_API_KEY||!process.env.OPENAI_MODEL){console.error('Usage: node scripts/run-image.mjs <image-path> [export-json-path]; configure OPENAI_API_KEY and OPENAI_MODEL.');process.exit(1);}
const store=new Store(dataDir);let timer;
try {
  const isRecordMode=['--resume','--recheck-ocr'].includes(path);
  const prepared=isRecordMode?null:await prepareImage(readFileSync(resolve(path)));
  let r=isRecordMode?store.get(process.argv[3]):store.create(prepared.image,prepared.bytes,process.env.OPENAI_MODEL);
  if(path==='--recheck-ocr'){
    if(!r)throw new Error('Source record missing');
    const source=r;r=store.create(source.image,store.image(source.id),process.env.OPENAI_MODEL);
    r.reusedFromAnalysisId=source.id;r.reusedArtifacts=[];
    for(const name of ['discovery','ocr','detection','detection_additional'])if(source.stages[name]?.status==='completed'){
      r.artifacts[name]=source.artifacts[name];r.stages[name]=source.stages[name];r.reusedArtifacts.push(name);
      if(source.artifacts[`${name}_raw`])r.artifacts[`${name}_raw`]=source.artifacts[`${name}_raw`];
    }
    for(const c of source.cues.filter(c=>c.source==='geominer_adaptation'&&c.kind==='non_text')){
      const name=`verify_${c.id}`;if(source.stages[name]?.status==='completed'){r.artifacts[name]=source.artifacts[name];r.stages[name]=source.stages[name];r.reusedArtifacts.push(name);}
    }
    store.save(r);
  }
  if(!r||['running','completed'].includes(r.status))throw new Error('Record unavailable or not retryable');
  console.log(JSON.stringify({recordId:r.id,status:'started'}));
  timer=setInterval(()=>{const current=store.get(r.id);console.log(JSON.stringify({status:current.status,stages:Object.fromEntries(Object.entries(current.stages).map(([key,value])=>[key,value.status]))}));},30000);
  const result=await runPipeline(store,r.id);
  const exportPath=process.argv[isRecordMode?4:3];
  if(exportPath)writeFileSync(resolve(exportPath),JSON.stringify(result,null,2));
  console.log(JSON.stringify({recordId:r.id,status:result.status,cueCount:result.cues.length,text:result.cues.filter(c=>c.kind==='text').length,nonText:result.cues.filter(c=>c.kind==='non_text').length,supported:result.cues.filter(c=>c.localization.status==='supported').length,errors:result.errors}));
  if(result.status!=='completed')process.exitCode=2;
}finally{clearInterval(timer);store.close();}
