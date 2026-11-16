import { PROMPT_VERSION,DISCOVERY_PROMPT,OCR_PROMPT,VERIFY_PROMPT } from './prompts.mjs';
import { discoverySchema,ocrReviewSchema,ocrBatchSchema,reconcileOcrBatch,verificationSchema,verifyOcrCoverage,reconcileProposalChecks,bounds } from './contracts.mjs';
import { imageInput,realAdapters } from './adapters.mjs';
// How many model calls one analysis may have in flight at once (OCR review batches, cue verifications).
const VLM_CONCURRENCY=Math.max(1,Math.floor(Number(process.env.KKOK_VLM_CONCURRENCY))||4);
// Runs fn over items with at most `limit` in flight and returns results in item order. After a failure
// no new item starts; those already running finish (and keep their checkpoints) before the error is thrown.
export async function pool(items,fn,limit=VLM_CONCURRENCY){
  const results=new Array(items.length);let next=0,failed=false,error;
  const worker=async()=>{while(!failed&&next<items.length){const i=next++;try{results[i]=await fn(items[i],i);}catch(e){if(!failed){failed=true;error=e;}}}};
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  if(failed)throw error;
  return results;
}
export function assembleCues(r){
  const discovered=r.artifacts.discovery?.cues||[];const groups=r.artifacts.ocr_review?.groups||[];const lines=r.artifacts.ocr?.lines||[];
  const base=discovered.map((c,i)=>({...c,id:`cue-${i}`,source:'geominer_adaptation',sourceIndex:i,disposition:'candidate',evidenceGroupIds:[],localization:{status:'unlocalized',proposals:[]},geoSpecificityVerified:false}));
  groups.forEach((g,i)=>{
    const id=`ocr-cue-${i}`,box=bounds(g.lineIds.map(id=>lines.find(l=>l.id===id).polygon));
    const directlyReviewed=r.artifacts.ocr_review?.reviewMode==='per_region_crops';
    // Geographic irrelevance does not mean the OCR region is visually incorrect.
    const verdict=directlyReviewed?(g.disposition==='irrelevant'?'not_assessed':g.disposition==='candidate'&&g.visibility==='clear'?'supported':'partial'):'pending';
    const proposal={id:`ocr-region-${i}`,source:'paddleocr',bbox:box,polygons:g.lineIds.map(id=>lines.find(l=>l.id===id).polygon),lineIds:g.lineIds,verdict,evidenceKo:directlyReviewed?g.observationKo:null,verificationSource:directlyReviewed?'ocr_crop_review':null,score:null};
    base.push({id,kind:'text',category:g.category,nameKo:g.nameKo,observationKo:g.observationKo,geographicRelevanceKo:g.geographicRelevanceKo,regionDescriptionKo:g.regionDescriptionKo,scope:'object',surface:g.surface,visibility:g.visibility,visibleText:g.correctedText??g.lineIds.map(id=>lines.find(l=>l.id===id).text).join(' '),rawReadings:g.lineIds.map(id=>({id,text:lines.find(l=>l.id===id).text})),correctedText:g.correctedText,detectorQueryEn:null,limitationsKo:g.limitationsKo,source:'ocr_review',disposition:g.disposition,evidenceGroupIds:[id],geoSpecificityVerified:false,localization:{status:'proposed',proposals:[proposal]}});
    for(const index of g.relatedDiscoveryIndexes){base[index].evidenceGroupIds.push(id);base[index].localization.proposals.push({...proposal,id:`link-${index}-${i}`,verdict:'pending',verificationSource:null,associationStatus:'model_proposed'});}
  });
  for(const request of [...(r.artifacts.detection?.requests||[]),...(r.artifacts.detection_additional?.requests||[])]){const c=base.find(c=>c.id===request.cueId);if(c)c.localization.proposals.push(...request.detections.map(d=>({...d,source:'grounding_dino',verdict:'pending',evidenceKo:null})));}
  for(const c of base){
    const checks=r.artifacts[`verify_${c.id}`]?.checks||[];
    c.localization.proposals=c.localization.proposals.map(p=>{const check=checks.find(x=>x.proposalId===p.id);return check?{...p,verdict:check.verdict,evidenceKo:check.evidenceKo}:p;});
    const ps=c.localization.proposals;c.localization.status=ps.some(p=>p.verdict==='supported')?'supported':ps.some(p=>p.verdict==='pending')?'proposed':ps.some(p=>p.verdict==='partial')?'partial':ps.some(p=>p.verdict==='not_assessed')?'not_assessed':ps.length?'rejected':'unlocalized';
    c.localization.mask=null;
  }
  return base;
}
export async function runPipeline(store,id,adapters=realAdapters){
  const r=store.get(id);const bytes=store.image(id);r.status='running';r.errors=[];r.promptVersion=PROMPT_VERSION;store.save(r);
  async function stage(name,fn){
    if(r.stages[name]?.status==='completed')return r.artifacts[name];
    r.stages[name]={status:'running',startedAt:new Date().toISOString()};store.save(r);
    try{const result=await fn();r.artifacts[name]=result;r.stages[name]={...r.stages[name],status:'completed',finishedAt:new Date().toISOString()};r.cues=assembleCues(r);store.save(r);return result;}
    catch(e){r.stages[name]={...r.stages[name],status:'failed',finishedAt:new Date().toISOString(),error:'STAGE_FAILED'};r.errors.push({stage:name,code:'STAGE_FAILED',httpStatus:Number.isInteger(e.status)?e.status:null});store.save(r);return null;}
  }
  async function vlm(name,prompt,schema,content){return adapters.vlm({model:r.requestedModel,prompt,schema,name:'cue_result',content,onRaw:raw=>{r.modelCalls??=[];r.modelCalls.push({stage:name,at:new Date().toISOString(),...raw});r.artifacts[`${name}_raw`]=raw;store.save(r);}});}
  // Stages that do not need each other's output run together: discovery (API) with OCR (local), then
  // OCR review (API) with detection (local). Every stage still checkpoints itself, so a retry skips what finished.
  const [discovery,ocr]=await Promise.all([
    stage('discovery',()=>vlm('discovery',DISCOVERY_PROMPT,discoverySchema,[imageInput(bytes),{type:'input_text',text:'Discover geographic cue candidates in this photo.'}])),
    stage('ocr',()=>adapters.ocr(bytes)),
  ]);
  // OCR has already been waited for, so nothing is still writing to this record after it is marked failed.
  if(!discovery){r.status='failed';store.save(r);return r;}
  const textCandidates=discovery.cues.flatMap((c,i)=>c.kind==='text'?[{index:i,...c}]:[]);
  const reviewOcr=()=>stage('ocr_review',async()=>{
    if(!ocr.lines.length)return {groups:[],limitationsKo:[]};
    if(adapters.ocrContext){
      const starts=[];for(let start=0;start<ocr.lines.length;start+=8)starts.push(start);
      // Batches are independent; results are joined in line order whatever order the calls return in.
      const batches=await pool(starts,async start=>{
        const lines=ocr.lines.slice(start,start+8),name=`ocr_batch_${start}`;
        if(r.artifacts[name])return r.artifacts[name];
        const sheets=await adapters.ocrContext(bytes,lines,r.image);
        const content=[imageInput(bytes),{type:'input_text',text:JSON.stringify({ocrLines:lines,discoveryTextCandidates:textCandidates,instruction:'This is a per-region review batch. Return one group containing exactly ONE OCR ID for each supplied line. Never merge IDs. Each labeled crop follows on a contact sheet. Other OCR regions are not part of this batch.'})},...sheets.map(imageInput)];
        const raw=await vlm(name,OCR_PROMPT,ocrBatchSchema(lines.map(l=>l.id)),content);
        const checked=reconcileOcrBatch(raw,lines,discovery);r.artifacts[name]=checked;store.save(r);
        return checked;
      });
      const all={groups:batches.flatMap(b=>b.groups),limitationsKo:batches.flatMap(b=>b.limitationsKo)};
      return {...verifyOcrCoverage(all,ocr,discovery),reviewMode:'per_region_crops'};
    }
    const content=[imageInput(bytes),{type:'input_text',text:JSON.stringify({ocrLines:ocr.lines,discoveryTextCandidates:textCandidates})}];
    const initial=await vlm('ocr_review',OCR_PROMPT,ocrReviewSchema,content);
    try{return verifyOcrCoverage(initial,ocr,discovery);}
    catch {
      content.push({type:'input_text',text:JSON.stringify({previousOutput:initial,correctionRequired:'Return a corrected complete grouping. Every input OCR ID must occur exactly once overall. Remove duplicates, include omitted IDs, and use only supplied text discovery indexes. Recheck actual crop locations; do not join distant inscriptions.'})});
      return verifyOcrCoverage(await vlm('ocr_review_repair',OCR_PROMPT,ocrReviewSchema,content),ocr,discovery);
    }
  });
  const queries=discovery.cues.flatMap((c,i)=>c.detectorQueryEn?[{cueId:`cue-${i}`,query:c.detectorQueryEn}]:[]);
  const detect=async()=>{
    if(queries.length)await stage('detection',()=>adapters.detect(bytes,queries));
    else await stage('detection',async()=>({requests:[],reason:'No localizable queries'}));
    if(r.artifacts.detection){
      const covered=new Set(r.artifacts.detection.requests.map(q=>q.cueId));
      const missing=queries.filter(q=>!covered.has(q.cueId));
      if(missing.length)await stage('detection_additional',()=>adapters.detect(bytes,missing));
    }
  };
  await Promise.all([ocr?reviewOcr():null,detect()]);
  r.cues=assembleCues(r);store.save(r);
  // Work from a stable cue snapshot: each cue's verification is checkpointed independently, so cues run together.
  await pool([...r.cues],async cue=>{
    const proposals=cue.localization.proposals;if(!proposals.length||cue.disposition==='irrelevant')return;
    const previous=r.artifacts[`verify_${cue.id}`]?.checks||[];
    const unchecked=proposals.filter(p=>p.verdict==='pending'&&!previous.some(c=>c.proposalId===p.id));
    if(!unchecked.length)return;
    if(r.stages[`verify_${cue.id}`]?.status==='completed')r.stages[`verify_${cue.id}`].status='pending';
    await stage(`verify_${cue.id}`,async()=>{
      const checks=[...previous];
      for(let offset=0;offset<unchecked.length;offset+=8){
        const batch=unchecked.slice(offset,offset+8);const content=[{type:'input_text',text:JSON.stringify({cue,context:'Full analysis image follows; labeled crops follow next.'})},imageInput(bytes)];
        for(const p of batch){content.push({type:'input_text',text:JSON.stringify({proposalId:p.id,source:p.source,bbox:p.bbox})},imageInput(await adapters.crop(bytes,p.bbox,r.image)));}
        const name=`verify_${cue.id}_${offset}`;const output=await vlm(name,VERIFY_PROMPT,verificationSchema,content);checks.push(...reconcileProposalChecks(output,batch).checks);
      }
      return {checks};
    });
  });
  r.cues=assembleCues(r);r.status=Object.values(r.stages).some(s=>s.status==='failed')?'partial':'completed';store.save(r);return r;
}
