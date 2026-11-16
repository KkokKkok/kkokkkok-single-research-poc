import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { assembleCues } from '../lib/pipeline.mjs';
const id=process.argv[2],outputDir=resolve(process.argv[3]||'..');
const store=new Store(dataDir);
try {
  const r=store.get(id);if(!r)throw new Error('Record not found');
  const originalArtifacts=JSON.stringify(r.artifacts);
  r.cues=assembleCues(r);r.derivationVersion='cue-projection-v2';r.derivedAt=new Date().toISOString();
  if(JSON.stringify(r.artifacts)!==originalArtifacts)throw new Error('Raw artifact mutated');
  store.save(r);
  writeFileSync(resolve(outputDir,'photo-test-result.json'),JSON.stringify(r,null,2));
  const original=r.cues.filter(c=>c.source==='geominer_adaptation');
  const stats={recordId:r.id,status:r.status,initialCandidates:original.length,initialText:original.filter(c=>c.kind==='text').length,initialNonText:original.filter(c=>c.kind==='non_text').length,ocrRegions:r.artifacts.ocr.lines.length,allRecords:r.cues.length,supportedRecords:r.cues.filter(c=>c.localization.status==='supported').length,dispositions:r.cues.reduce((a,c)=>(a[c.disposition]=(a[c.disposition]||0)+1,a),{}),errors:r.errors};
  writeFileSync(resolve(outputDir,'photo-test-summary.json'),JSON.stringify(stats,null,2));
  console.log(JSON.stringify(stats));
}finally{store.close();}
