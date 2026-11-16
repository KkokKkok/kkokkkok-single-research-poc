import { z } from './config.mjs';
const text = z.string().min(1).max(2000);
export const boxSchema = z.tuple([z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1),z.number().min(0).max(1)]).refine(b=>b[2]>b[0]&&b[3]>b[1], 'Degenerate box');
export const cueSchema = z.object({
  kind:z.enum(['text','non_text']), category:z.string().min(1).max(100),
  nameKo:text, observationKo:text, geographicRelevanceKo:text,
  regionDescriptionKo:text, scope:z.enum(['object','group','scene','relation']),
  visibleText:z.string().max(2000).nullable(),
  surface:z.enum(['fixed','movable','reflection','depicted','unknown']),
  visibility:z.enum(['clear','partial','uncertain']),
  detectorQueryEn:z.string().min(3).max(160).nullable(),
  limitationsKo:text,
}).strict();
export const discoverySchema = z.object({
  cues:z.array(cueSchema).max(80), limitationsKo:z.array(text).max(30),
  coverageLimited:z.boolean(),
}).strict();
export const ocrReviewSchema = z.object({groups:z.array(z.object({
  lineIds:z.array(z.string()).min(1).max(100),
  disposition:z.enum(['candidate','uncertain','irrelevant']),
  category:z.string().min(1).max(100), nameKo:text, observationKo:text,
  geographicRelevanceKo:text, regionDescriptionKo:text,
  correctedText:z.string().max(2000).nullable(),
  surface:z.enum(['fixed','movable','reflection','depicted','unknown']),
  visibility:z.enum(['clear','partial','uncertain']),
  limitationsKo:text,
  relatedDiscoveryIndexes:z.array(z.number().int().nonnegative()).max(80),
}).strict()).max(500),limitationsKo:z.array(text).max(30)}).strict();
export function ocrBatchSchema(ids){
  const group=ocrReviewSchema.shape.groups.element.extend({lineIds:z.array(z.enum(ids)).length(1)}).strict();
  return z.object({groups:z.array(group).max(ids.length),limitationsKo:z.array(text).max(30)}).strict();
}
export function reconcileOcrBatch(output,lines,discovery){
  const known=new Set(lines.map(l=>l.id));
  if(output.groups.some(g=>g.lineIds.length!==1||!known.has(g.lineIds[0])))throw new Error('Invalid batch OCR reference');
  const groups=lines.map(line=>{
    const matches=output.groups.filter(g=>g.lineIds[0]===line.id);
    if(matches.length===1&&new Set(matches[0].relatedDiscoveryIndexes).size===matches[0].relatedDiscoveryIndexes.length&&matches[0].relatedDiscoveryIndexes.every(i=>discovery.cues[i]?.kind==='text'))return matches[0];
    return {lineIds:[line.id],disposition:'uncertain',category:'Unresolved Text',nameKo:'검토가 필요한 OCR 영역',observationKo:`OCR 원문: ${line.text}`,geographicRelevanceKo:'모델의 영역 배정이 유효하지 않아 위치 관련성을 확정하지 않았습니다.',regionDescriptionKo:'OCR이 반환한 영역',correctedText:null,surface:'unknown',visibility:'uncertain',limitationsKo:'모델의 누락·중복 또는 잘못된 참조를 서버가 보류 처리했습니다.',relatedDiscoveryIndexes:[]};
  });
  return {...output,groups};
}
export const verificationSchema=z.object({checks:z.array(z.object({
  proposalId:z.string(), verdict:z.enum(['supported','partial','rejected']),
  evidenceKo:text,
}).strict()).max(900)}).strict();
const point=z.tuple([z.number().min(0).max(1),z.number().min(0).max(1)]);
export const ocrSchema=z.object({engine:z.string(),version:z.string(),coordinateSpace:z.literal('analysis-normalized'),
  lines:z.array(z.object({id:z.string(),text:z.string().max(2000),score:z.number().min(0).max(1),polygon:z.array(point).length(4)}).passthrough()).max(500),diagnostics:z.unknown().optional()}).passthrough();
export const detectionSchema=z.object({engine:z.literal('Grounding DINO'),model:z.string(),revision:z.string(),
  imageSha256:z.string(),coordinateSpace:z.literal('analysis-normalized'),
  requests:z.array(z.object({cueId:z.string(),query:z.string(),detections:z.array(z.object({id:z.string(),bbox:boxSchema,score:z.number().min(0).max(1),label:z.string()}).strict()).max(900)}).strict()).max(80)}).strict();
export function jsonSchema(schema){return z.toJSONSchema(schema,{target:'draft-7'});}
export function bounds(polygons){const ps=polygons.flat();return boxSchema.parse([Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))]);}
export function verifyOcrCoverage(output,ocr,discovery){
  const ids=new Set(ocr.lines.map(l=>l.id)),used=new Set();
  for(const group of output.groups){
    if(new Set(group.relatedDiscoveryIndexes).size!==group.relatedDiscoveryIndexes.length)throw new Error('Duplicate discovery reference');
    for(const id of group.lineIds){if(!ids.has(id)||used.has(id))throw new Error('OCR coverage conflict');used.add(id);}
    for(const i of group.relatedDiscoveryIndexes)if(!discovery.cues[i]||discovery.cues[i].kind!=='text')throw new Error('Invalid discovery reference');
    bounds(group.lineIds.map(id=>ocr.lines.find(l=>l.id===id).polygon));
  }
  if(used.size!==ids.size)throw new Error('Missing OCR lines');
  return output;
}
export function verifyProposalCoverage(output, proposals){
  const expected=new Set(proposals.map(p=>p.id));const seen=new Set();
  for(const c of output.checks){if(!expected.has(c.proposalId)||seen.has(c.proposalId))throw new Error('Invalid proposal reference');seen.add(c.proposalId);}
  if(seen.size!==expected.size)throw new Error('Missing proposal checks');
  return output;
}
export function reconcileProposalChecks(output,proposals){
  return {checks:proposals.map(p=>{const matches=output.checks.filter(c=>c.proposalId===p.id);return matches.length===1?matches[0]:{proposalId:p.id,verdict:'partial',evidenceKo:'모델의 영역 ID 응답이 누락되거나 중복되어 대응을 확정하지 않았습니다.'};})};
}
export function cropPixels(b,width,height){boxSchema.parse(b);const left=Math.max(0,Math.floor(b[0]*width)),top=Math.max(0,Math.floor(b[1]*height));return {left,top,width:Math.max(1,Math.min(width,Math.ceil(b[2]*width))-left),height:Math.max(1,Math.min(height,Math.ceil(b[3]*height))-top)};}
