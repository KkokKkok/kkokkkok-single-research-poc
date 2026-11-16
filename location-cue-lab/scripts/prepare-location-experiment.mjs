import { readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { sharp,dataDir } from '../lib/config.mjs';
import { prepareImage } from '../lib/adapters.mjs';
import { VERSION,digest,parseGps,maskImage } from '../lib/location-experiment.mjs';
const [sourceDir,resultDir,outputDir]=process.argv.slice(2);if(!outputDir)throw new Error('Usage: prepare-location-experiment.mjs <original-folder> <completed-json-folder> <new-output-dir>');
const out=resolve(outputDir);if(existsSync(join(out,'manifest.json')))throw new Error('EXPERIMENT_ALREADY_EXISTS');mkdirSync(join(out,'images'),{recursive:true});
const cases=[],labels=[];
for(const file of readdirSync(resultDir).filter(f=>/^KakaoTalk_.+\.json$/.test(f)).sort()) {
  const r=JSON.parse(readFileSync(join(resultDir,file)));if(r.status!=='completed')continue;
  const filename=file.replace(/\.json$/,'.jpg'),original=readFileSync(join(sourceDir,filename)),normalized=await prepareImage(original);
  if(normalized.image.sha256!==r.image.sha256)throw new Error('SOURCE_RESULT_IMAGE_MISMATCH');
  const stored=readFileSync(join(dataDir,'images',`${r.id}.jpg`));if(digest(stored)!==r.image.sha256)throw new Error('STORED_IMAGE_MISMATCH');
  const id=`image-${String(cases.length+1).padStart(2,'0')}`,image=await sharp(stored).png().toBuffer();
  writeFileSync(join(out,'images',`${id}.png`),image);
  const item={id,image:`images/${id}.png`,sha256:digest(image),sourceAnalysisId:r.id,sourceAnalysisSha256:digest(readFileSync(join(resultDir,file))),conditions:['vanilla','cot','geominer']};
  // Pilot intervention selected before location predictions: main awning inscription only.
  // Smaller repetitions on the door/menu remain; this is not removal of all venue identity.
  if(filename.endsWith('_09.jpg')) {
    const bbox=[0,0.12,0.86,0.37],masked=await maskImage(image,bbox);
    const path=`images/${id}-masked.png`;writeFileSync(join(out,path),masked);
    item.mask={image:path,sha256:digest(masked),bbox,selection:'visible main awning inscription; fixed before prediction',remainingEvidence:'door/menu inscriptions and surrounding architecture remain',intervention:'opaque_gray_rectangle'};
    item.conditions.push('masked_sign');
  }
  cases.push(item);labels.push({id,filename,originalSha256:digest(original),...parseGps((await sharp(original).metadata()).exif)});
}
const manifest={version:VERSION,createdAt:new Date().toISOString(),study:'pilot_not_exact_paper_replication',topK:1,thresholdsM:[100,1000],cases};
writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));writeFileSync(join(out,'ground-truth.private.json'),JSON.stringify(labels,null,2));
writeFileSync(join(out,'.gitignore'),'*\n');
console.log(JSON.stringify({cases:cases.length,gpsFound:labels.filter(l=>l.status==='found').length,plannedPredictorCalls:cases.reduce((s,c)=>s+c.conditions.length,0),plannedDetectorCalls:cases.length,manifestSha256:digest(Buffer.from(JSON.stringify(manifest)))}));
