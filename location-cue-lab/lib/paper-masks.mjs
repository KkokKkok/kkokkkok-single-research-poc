// Masks for detector boxes. NOT part of the paper, and a step of its own after region linking: each
// Grounding DINO box is given to Segment Anything (scripts/segment.py), which returns the shape of
// what stands out inside it. Nothing here checks that the shape is what the clue describes: a wrong
// box gives a precise mask of the wrong thing. The box is kept; the mask is added to the region.
//   region.mask = {size:[height,width], counts:[...], score}
//   counts: run lengths over the mask read row by row, starting with a run of 0s (which may be empty).
//   The mask covers the whole photo, reduced so that its longer side is maskSide.
import { hasQuotedText } from './paper-risk.mjs';
import { ruleFor,usedClueIds } from './paper-rules.mjs';

export const MASK_VERSION='paper-masks-v1';
export const DEFAULT_MASK_SIDE=512;
const keyOf=bbox=>bbox.map(value=>value.toFixed(4)).join(',');
// The detector boxes of a record that get a mask. Boxes of a clue that quotes text are left out: such
// a clue is located by its OCR line and the viewer never draws its detector boxes.
// A low clue is left out too (owner's decision of 2026-11-18), unless it took part in an inference of
// the place (paper-rules.mjs usedClueIds: a member of a combination, confirmed by a search). A clue
// the hit guess named that does not give the place away by itself keeps its risk, and when that risk
// is low there is nothing to cover: its box stays, without a mask.
export function maskableRegions(run){
  const judge=ruleFor(run),used=usedClueIds(run);
  return run.clues.flatMap(clue=>hasQuotedText(clue)||(judge(clue).risk==='low'&&!used.has(clue.id))?[]:(clue.regions||[]).filter(region=>region.kind==='object'));
}
// Takes the masks off the boxes that are no longer to be masked (a clue whose risk went back to low
// after the masks were made). No tool is run. Returns how many masks were removed.
export function pruneMasks(run){
  const keep=new Set(maskableRegions(run));
  let removed=0;
  for(const clue of run.clues)for(const region of clue.regions||[])if(region.mask&&!keep.has(region)){delete region.mask;removed++;}
  if(removed&&run.masks)run.masks={...run.masks,regions:keep.size,pruned:(run.masks.pruned??0)+removed,prunedAt:new Date().toISOString()};
  return removed;
}
// Share of the mask that is set, 0..1.
export function maskArea(mask){
  let on=0;for(let index=1;index<mask.counts.length;index+=2)on+=mask.counts[index];
  return on/(mask.size[0]*mask.size[1]);
}
export function validMask(mask){
  return Array.isArray(mask?.size)&&mask.size.length===2&&mask.size.every(value=>Number.isInteger(value)&&value>0)&&Array.isArray(mask.counts)
    &&mask.counts.every(value=>Number.isInteger(value)&&value>=0)&&mask.counts.reduce((sum,value)=>sum+value,0)===mask.size[0]*mask.size[1];
}

// segment: async (bytes,[{id,bbox}],{maskSide}) => {engine,model,revision,masks:[{id,score,size,counts}],timing}
// The same box given to several clues (one ad panel, three clues) is sent once.
export async function maskRegions({bytes,run,segment,maskSide=DEFAULT_MASK_SIDE}){
  const regions=maskableRegions(run),unique=new Map();
  // Masks of an earlier run on boxes that are not masked any more do not stay behind.
  pruneMasks(run);
  for(const region of regions)if(!unique.has(keyOf(region.bbox)))unique.set(keyOf(region.bbox),{id:`box-${unique.size}`,bbox:region.bbox});
  if(!unique.size)return {summary:{version:MASK_VERSION,createdAt:new Date().toISOString(),verification:'none',maskSide,boxes:0,regions:0,engine:null,model:null,revision:null,timing:null}};
  const answer=await segment(bytes,[...unique.values()],{maskSide});
  const byId=new Map(answer.masks.map(mask=>[mask.id,mask]));
  for(const region of regions){
    const mask=byId.get(unique.get(keyOf(region.bbox)).id);
    if(!mask||!validMask(mask))throw new Error('MASK_INVALID');
    region.mask={size:mask.size,counts:mask.counts,score:mask.score};
  }
  return {summary:{version:MASK_VERSION,createdAt:new Date().toISOString(),verification:'none',maskSide,boxes:unique.size,regions:regions.length,engine:answer.engine,model:answer.model,revision:answer.revision,timing:answer.timing??null}};
}

// Adds masks to the detector boxes of one linked record and saves it. A record already masked is
// left alone unless force. The photo sent is the stored analysis image: boxes and masks are both
// fractions of the photo, so a tool copy of another size would give the same result.
export async function maskRunRegions({store,run,segment,maskSide=DEFAULT_MASK_SIDE,force=false}){
  if(!run.regions||(run.masks&&!force))return run;
  try{
    const {summary}=await maskRegions({bytes:store.image(run.id),run,segment,maskSide});
    run.masks=summary;
    // An earlier failed attempt of this step is settled by this one.
    run.errors=run.errors.filter(entry=>entry.stage!=='masks');
  }catch(error){
    run.errors.push({stage:'masks',code:error?.message||'MASK_FAILED',at:new Date().toISOString()});
  }
  return store.saveRun(run);
}
