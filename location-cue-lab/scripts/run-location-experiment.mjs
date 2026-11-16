import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,readdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {root} from '../lib/config.mjs';
import {VERSION,digest,DETECTOR_PROMPT,detectorSchema,predictionSchema,validatePrediction,promptFor,modelContent,callExperimentModel,geocodeAddress} from '../lib/location-experiment.mjs';
const [directory,provider,model,detectorProvider,detectorModel]=process.argv.slice(2);
const rescore=process.argv.includes('--rescore');
if(!detectorModel)throw new Error('Usage: run-location-experiment.mjs <dir> <provider> <analyzer-model> <detector-provider> <detector-model>');
const out=resolve(directory),manifest=JSON.parse(readFileSync(join(out,'manifest.json')));
if(manifest.version!==VERSION)throw new Error('VERSION_MISMATCH');
if(!rescore)for(const p of [provider,detectorProvider])if(p==='openai'?!process.env.OPENAI_API_KEY:p==='gemini'?!(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY):true)throw new Error('PROVIDER_NOT_CONFIGURED');
const config={version:VERSION,manifestSha256:digest(readFileSync(join(out,'manifest.json'))),provider,model,detectorProvider,detectorModel,detectorPrompt:DETECTOR_PROMPT,prompts:Object.fromEntries(['vanilla','cot','geominer','masked_sign'].map(k=>[k,promptFor(k)])),schemaHashes:[predictionSchema,detectorSchema].map(s=>digest(Buffer.from(s.toJSONSchema?JSON.stringify(s.toJSONSchema()):String(s))))};
const runId=digest(Buffer.from(JSON.stringify(config))).slice(0,16),runDir=join(out,'runs',runId);mkdirSync(runDir,{recursive:true});
function save(file,data){const p=join(runDir,file);writeFileSync(p+'.tmp',JSON.stringify(data,null,2));renameSync(p+'.tmp',p);}
save('config.json',config);
if(rescore){
  const history=join(runDir,'scoring-history',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(history,{recursive:true});
  for(const name of readdirSync(runDir).filter(n=>n.endsWith('-score.json')||['scores.json','summary.json','report.md'].includes(n)))copyFileSync(join(runDir,name),join(history,name));
}
async function perform(name,args,validator) {
  const file=`${name}.json`,path=join(runDir,file);
  if(existsSync(path))return JSON.parse(readFileSync(path)); // Never silently rebill failed/interrupted requests.
  const r={name,status:'running',startedAt:new Date().toISOString(),inputSha256:digest(Buffer.from(JSON.stringify(args.content))),promptSha256:digest(Buffer.from(args.prompt))};save(file,r);
  try {const result=await callExperimentModel({...args,onRaw:raw=>{r.raw=raw;save(file,r);}});r.status=result.refusal?'refused':'completed';if(!result.refusal)r.output=validator(result);}
  catch(e){r.status='failed';r.error={code:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'MODEL_OR_SCHEMA_FAILURE',httpStatus:Number.isInteger(e.status)?e.status:null};}
  r.finishedAt=new Date().toISOString();save(file,r);console.log(JSON.stringify({runId,job:name,status:r.status}));return r;
}
if(!rescore)for(const c of manifest.cases) {
  const bytes=readFileSync(join(out,c.image));if(digest(bytes)!==c.sha256)throw new Error('IMAGE_HASH_MISMATCH');
  let detector;
  for(const condition of c.conditions) {
    if(condition==='geominer') {
      detector=await perform(`${c.id}-detector`,{provider:detectorProvider,model:detectorModel,prompt:DETECTOR_PROMPT,schema:detectorSchema,content:modelContent(bytes,'vanilla')},v=>detectorSchema.parse(v));
      if(detector.status!=='completed')continue;
    }
    const input=condition==='masked_sign'?readFileSync(join(out,c.mask.image)):bytes;
    if(condition==='masked_sign'&&digest(input)!==c.mask.sha256)throw new Error('MASK_HASH_MISMATCH');
    const r=await perform(`${c.id}-${condition}`,{provider,model,prompt:promptFor(condition),schema:predictionSchema,content:modelContent(input,condition,detector?.output)},validatePrediction);
    if([401,403,429].includes(r.error?.httpStatus))throw new Error('API_STOP_REQUIRED');
  }
}
// Ground truth is opened ONLY after all model predictions have been committed.
const truth=JSON.parse(readFileSync(join(out,'ground-truth.private.json'))),scores=[];
let geocodingBlocked=false;
for(const c of manifest.cases)for(const condition of c.conditions) {
  const file=`${c.id}-${condition}.json`,path=join(runDir,file),r=existsSync(path)?JSON.parse(readFileSync(path)):null;
  const label=truth.find(t=>t.id===c.id),s={imageId:c.id,condition,modelStatus:r?.status??'dependency_failed',answered:r?.status==='completed'&&!r.output.abstained,scoreStatus:'not_answered',distanceM:null,preciseLocation:false,within100m:false,within1000m:false};
  const priorPath=join(runDir,`${c.id}-${condition}-score.json`);
  if(!rescore&&existsSync(priorPath)){scores.push(JSON.parse(readFileSync(priorPath)));continue;}
  if(s.answered) {
    if(label?.status!=='found')s.scoreStatus='missing_truth';
    else if(geocodingBlocked)s.scoreStatus='geocoder_unavailable';
    else {
      try {
        const g=await geocodeAddress(r.output.address);s.scoreStatus=`geocode_${g.status}`;
        if(['REQUEST_DENIED','OVER_DAILY_LIMIT','OVER_QUERY_LIMIT','key_missing'].includes(g.status))geocodingBlocked=true;
        if(g.status==='resolved') {
          // Provider coordinates are used transiently. Persist the distance and exempt place ID, not the geocoder body.
          const p=spawnSync(process.env.EXPERIMENT_PYTHON||'python',[join(root,'scripts','experiment-distance.py')],{input:JSON.stringify({predicted:g,truth:label}),encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONPATH:join(root,'private-data','experiment-python')},timeout:30000});
          if(p.status!==0)throw new Error('DISTANCE_ENGINE_FAILED');
          const measured=JSON.parse(p.stdout);if(!Number.isFinite(measured.distanceM))throw new Error('DISTANCE_INVALID');
          Object.assign(s,{scoreStatus:'scored',distanceM:measured.distanceM,metric:measured.metric,placeId:g.placeId,locationType:g.locationType,types:g.types,truthAccuracyM:label.accuracyM});
          s.preciseLocation=['ROOFTOP','RANGE_INTERPOLATED'].includes(g.locationType)&&g.types.some(t=>['street_address','premise','subpremise'].includes(t));
          s.within100m=s.preciseLocation&&s.distanceM<=100;s.within1000m=s.preciseLocation&&s.distanceM<=1000;
        }
      }catch{s.scoreStatus='scoring_failed';}
    }
  }
  save(`${c.id}-${condition}-score.json`,s);scores.push(s);
}
save('scores.json',scores);
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2;};
const conditions=[...new Set(scores.map(s=>s.condition))],summary=conditions.map(condition=>{const a=scores.filter(s=>s.condition===condition),d=a.filter(s=>s.scoreStatus==='scored').map(s=>s.distanceM);return {condition,planned:a.length,completed:a.filter(s=>s.modelStatus==='completed').length,answered:a.filter(s=>s.answered).length,scored:d.length,precise:a.filter(s=>s.preciseLocation).length,meanDistanceM:mean(d),medianDistanceM:median(d),within100m:a.filter(s=>s.within100m).length,within1000m:a.filter(s=>s.within1000m).length};});
const pairs=[];for(const c of manifest.cases)for(const [base,intervention]of [['cot','geominer'],['vanilla','cot'],['vanilla','masked_sign']]){const a=scores.find(s=>s.imageId===c.id&&s.condition===base),b=scores.find(s=>s.imageId===c.id&&s.condition===intervention);if(!b)continue;pairs.push({imageId:c.id,base,intervention,comparable:a?.scoreStatus==='scored'&&b.scoreStatus==='scored',distanceDeltaM:a?.scoreStatus==='scored'&&b.scoreStatus==='scored'?b.distanceM-a.distanceM:null});}
save('summary.json',{runId,summary,pairs});
const lines=['# 위치 단서 비교 실험 결과','',`실행: ${runId} / 분석 모델: ${provider}:${model} / 발견 모델: ${detectorProvider}:${detectorModel}`,'','논문 방법을 한국 사진 10장에 적용한 파일럿이며 논문의 수치 재현 실험은 아니다. 정답 GPS는 모델 호출 완료 후 로컬 채점에만 사용했다.','', '| 조건 | 계획 | 모델 완료 | 주소 응답 | 거리 채점 | 정밀 좌표 | 평균 거리(m) | 중앙 거리(m) | 100m 이내* | 1km 이내* |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
for(const s of summary)lines.push(`| ${s.condition} | ${s.planned} | ${s.completed} | ${s.answered} | ${s.scored} | ${s.precise} | ${s.meanDistanceM?.toFixed(1)??'—'} | ${s.medianDistanceM?.toFixed(1)??'—'} | ${s.scored?`${s.within100m}/${s.planned}`:'미채점'} | ${s.scored?`${s.within1000m}/${s.planned}`:'미채점'} |`);
if(!scores.some(s=>s.scoreStatus==='scored'))lines.push('','**현재 유효한 거리 채점이 없어 정확도와 조건별 우열을 판단할 수 없다. 성공 수 0을 정확도 0%로 해석하지 않는다.**');
lines.push('','* 임계값은 이 파일럿 설정이며 논문의 CCPA 지표가 아니다. street_address/premise/subpremise 및 ROOFTOP/RANGE_INTERPOLATED만 정밀 좌표로 집계한다. 도시 중심 등 광역 지오코딩은 가까워도 성공으로 세지 않는다. 평균·중앙 거리는 채점 가능한 응답에 한정하므로 조건별 분모가 다르면 단순 우열 비교를 피한다. 주소 응답률도 논문의 VRR와 완전히 동일한 계약이 아니다.','', '## 사진별 결과','', '| 사진 ID | 조건 | 모델 | 채점 | 거리(m) | 정밀 좌표 |','|---|---|---|---|---:|---|');
for(const s of scores)lines.push(`| ${s.imageId} | ${s.condition} | ${s.modelStatus} | ${s.scoreStatus} | ${s.distanceM?.toFixed(1)??'—'} | ${s.preciseLocation?'예':'아니오'} |`);
lines.push('','## 짝지은 비교','', '| 사진 ID | 비교 | 거리 변화(m), 음수=개선 |','|---|---|---:|');for(const p of pairs)lines.push(`| ${p.imageId} | ${p.base} → ${p.intervention} | ${p.distanceDeltaM?.toFixed(1)??'채점 불가'} |`);
lines.push('','마스킹은 09번 큰 차양 간판 영역만 가린 1회 실험이다. 문·메뉴판의 반복 상호와 다른 단서가 남고 주변 픽셀도 함께 가려진다. 반복 시행·대조 마스크·사람 검토가 없으므로 개별 단서의 인과적 유용성 또는 일반화 성능을 단정하지 않는다. 사진들은 이전 개발 과정에서 본 파일럿 자료다. EXIF GPS도 사용자가 확인한 측량 정답은 아니며 정확도와 촬영자/대상 위치 차이를 고려해야 한다.');
writeFileSync(join(runDir,'report.md'),lines.join('\n'));console.log(JSON.stringify({runId,summary}));
