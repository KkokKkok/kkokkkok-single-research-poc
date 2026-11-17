// A paper-pipeline record as the inspection response the Spring backend expects from its analysis
// server (kkokkkok-backend NodeAnalysisClient / InspectionConverter) and the Android app parses
// (kkokkkok-android BackendAnalysisRepository.parseAnalysisResult). NOT a paper step.
//
// What the two consumers read, as of 2026-11-17 (backend bb271a4, android a9680fd):
//   backend  inspectionId (UUID, equal to the Idempotency-Key it sent) and status
//            (queued | processing | completed | failed) are checked; everything else is passed on
//            to the app untouched and stored.
//            edits:       riskFactors[].id, .bbox ([left,top,right,bottom], 0..1), .coordinateSpace
//                         ('analysis-normalized'), .type, .title; a cue without a bbox cannot be edited
//            cumulative:  riskFactors[].humanRisk ?? .modelRisk (high | medium | low), .title
//   android  riskSummary (required when completed; score null or 0..100)
//            riskFactors[]: id, type (-> icon: text | building | object | metadata), title (shown
//            unless equal to type), description, detail, modelReason, modelRisk, bbox, coordinateSpace
//            visualObservations[]: listed as further clues without a risk; one sharing an id with a
//            factor only lends it a bbox
//            pipelineStages.ocr / .objectDetection: failed or unavailable marks the result partial
// Fields neither reads yet are added under names of their own (unit, ruleClass, regions with polygon
// and mask, combinations): both pass unknown fields through, so they can be taken up later.
import { ruleOf,RULE_CLASSES,RULE_UNITS,RULE_VERSION } from './paper-rules.mjs';
import { trustedRegions,hasQuotedText } from './paper-risk.mjs';

export const INSPECTION_VERSION='paper-inspection-v1';
export const COORDINATE_SPACE='analysis-normalized';
const RISK_ORDER=['low','medium','high'];
const highest=risks=>RISK_ORDER[Math.max(-1,...risks.map(risk=>RISK_ORDER.indexOf(risk)))]??null;
const validBox=bbox=>Array.isArray(bbox)&&bbox.length===4&&bbox.every(value=>Number.isFinite(value)&&value>=0&&value<=1)&&bbox[0]<bbox[2]&&bbox[1]<bbox[3];

// The app picks an icon from `type` and knows only these words.
const TYPE_BY_CLASS={structure:'building',view:'building'};
export const factorType=clue=>hasQuotedText(clue)?'text':TYPE_BY_CLASS[clue.rule?.class]??'object';

// The one box a factor carries, since the edit step takes one per cue: a region a tool confirmed
// before the model's own box, then the higher score. All regions are listed next to it.
// OCR reads a sign as several lines ("달빛고양이", "책방"): the text regions that are parts of the
// same quoted text are one thing to cover, so their boxes are joined. Object boxes are not joined:
// they answer different search phrases and can lie anywhere in the photo.
export function mainRegion(clue){
  const regions=trustedRegions(clue).filter(region=>validBox(region.bbox));
  const best=[...regions].sort((a,b)=>(a.verified===false)-(b.verified===false)||(b.score??0)-(a.score??0))[0]??null;
  if(best?.kind!=='text'||!best.quoted)return best;
  const parts=regions.filter(region=>region.kind==='text'&&region.quoted===best.quoted&&(region.verified===false)===(best.verified===false));
  return {...best,bbox:[Math.min(...parts.map(part=>part.bbox[0])),Math.min(...parts.map(part=>part.bbox[1])),Math.max(...parts.map(part=>part.bbox[2])),Math.max(...parts.map(part=>part.bbox[3]))]};
}
const regionOut=(region,masks)=>({id:region.id,kind:region.kind,source:region.source,bbox:region.bbox,coordinateSpace:COORDINATE_SPACE,
  verified:region.verified!==false,...(region.polygon?{polygon:region.polygon}:{}),...(masks&&region.mask?{mask:region.mask}:{})});

// The status of the record as an inspection. A record is complete once the clues are judged by the
// rule sheet and looked for in the photo; a record without clues has nothing left to do.
export function inspectionStatus(run){
  if(run.status==='failed')return 'failed';
  if(['queued','registered'].includes(run.status))return 'queued';
  if(['extracted','classified'].includes(run.status)&&(!run.clues.length||(run.rules&&run.regions)))return 'completed';
  return 'processing';
}
const stageStatus=(run,status,stage,done)=>done?'completed':run.errors?.some(entry=>entry.stage===stage)||status==='failed'?'failed':status;

// status: given by whoever runs the steps (a job queue knows when it stopped); derived when absent.
// masks: false leaves the run-length masks out (they are most of the response's size).
export function toInspection(run,{status=inspectionStatus(run),masks=true}={}){
  const judged=Boolean(run.rules);
  const riskFactors=(run.clues||[]).map(clue=>{
    const rule=ruleOf(clue),region=mainRegion(clue),type=factorType(clue);
    return {
      id:clue.id,type,
      title:(judged&&rule.situation)||RULE_CLASSES[rule.class]||clue.taxonomy?.name||clue.category||type,
      description:clue.detail,detail:null,
      text:clue.textTargets?.[0]??null,
      bbox:region?.bbox??null,coordinateSpace:COORDINATE_SPACE,
      sources:[...new Set(trustedRegions(clue).map(item=>item.source))],
      assessmentSource:'model',
      // A clue not judged yet has no risk: the category default is not the sheet's reading.
      modelRisk:rule.judged?rule.risk:null,humanRisk:null,
      modelReason:rule.judged?rule.basis:null,
      unit:rule.judged?rule.unit:null,unitLabel:rule.judged?RULE_UNITS[rule.unit].ko:null,
      ruleClass:rule.judged?rule.class:null,category:clue.taxonomy?.name??clue.category??null,
      regions:trustedRegions(clue).filter(item=>validBox(item.bbox)).map(item=>regionOut(item,masks)),
    };
  });
  const known=new Set(riskFactors.map(factor=>factor.id));
  const combinations=(run.rules?.combinations||[]).filter(combo=>combo.clueIds.every(id=>known.has(id)))
    .map(({id,type,clueIds,unit,risk,reason})=>({id,type,clueIds,unit,unitLabel:RULE_UNITS[unit]?.ko??null,risk,reason}));
  const level=status!=='completed'&&status!=='failed'?'pending':judged?highest([...riskFactors.map(factor=>factor.modelRisk),...combinations.map(combo=>combo.risk)])??'low':'not_assessed';
  const linked=Boolean(run.regions);
  return {
    inspectionId:run.id,status,mock:false,
    pipelineVersion:`${INSPECTION_VERSION}+${run.schemaVersion??'paper-clues'}${judged?`+${run.rules.version??RULE_VERSION}`:''}`,
    image:{width:run.image.width,height:run.image.height,coordinateSpace:COORDINATE_SPACE,url:null},
    progress:{extraction:run.detector?'completed':status,rules:judged?'completed':status,regions:linked?'completed':status},
    // No score: the rule sheet gives a unit per clue, not a number.
    riskSummary:{score:null,level},
    riskFactors,
    visualObservations:[],
    combinations,
    pipelineStages:{visualObservation:run.detector?'completed':status,ocr:stageStatus(run,status,'regions',linked),objectDetection:stageStatus(run,status,'regions',linked)},
    error:status==='failed'?{message:'분석에 실패했습니다.'}:null,
    model:run.stages?.detector?.model??null,
  };
}
