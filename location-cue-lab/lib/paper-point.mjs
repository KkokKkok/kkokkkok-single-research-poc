// Not a paper step. A stand-in box for a clue that took part in an inference of the place (a member
// of a combination, or confirmed by a map search: paper-rules.mjs usedClueIds) and that the detector
// did not find. A distant transmission tower is half of what gives the place away together with the
// gate in front of it, and Grounding DINO returns nothing for it: without a region it can neither be
// shown nor covered. So the model that reads the photo is asked where the thing is, as it already is
// for text OCR could not read (paper-text-recheck.mjs).
//   region = {source:'model_point', kind:'object', verified:false, bbox, score:null}
// No tool confirmed the box and the model's boxes are rough: whoever draws or counts regions tells it
// apart by `verified`. The mask step (paper-masks.mjs) treats it like any detector box.
// Only clues that quote no text are asked about: a quoted text has its own recheck.
import { hasQuotedText } from './paper-risk.mjs';
import { displayRegions } from './paper-preview.mjs';
import { usedClueIds } from './paper-rules.mjs';

export const POINT_VERSION='clue-point-v1';
export const POINT_SOURCE='model_point';
export const MAX_POINT_AREA=0.8;
export const POINT_TEMPLATE=`Below are clues that were written about this photo. Each describes something visible in it. For each clue, find the single object or structure the clue is about and give its bounding box.

- "box": [x0, y0, x1, y1], fractions of the image width (x) and height (y) between 0 and 1, three decimals, origin at the top-left corner, x0 < x1 and y0 < y1. Cover the whole thing; a little too large is better than too small.
- Give null for a clue about the photo as a whole, or for a thing you cannot find in the photo.

Clues:
<<CLUES>>

Answer with only this JSON, every key exactly once:
\`\`\`json
{"clue-0": [0.120, 0.340, 0.250, 0.390], "clue-1": null}
\`\`\`
`;
export const pointPrompt=clues=>POINT_TEMPLATE.replace('<<CLUES>>',()=>clues.map(clue=>`${clue.id}: ${clue.detail}`).join('\n'));
const area=box=>(box[2]-box[0])*(box[3]-box[1]);
// {clueId: box|null}. A malformed answer is an error; a box that is not one, or that covers most of
// the photo, is no box.
export function parsePoints(answer,ids){
  const text=String(answer||''),fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(text.match(/\{[\s\S]*\}/)||[])[0],text.trim()]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed)throw new Error('POINT_ANSWER_INVALID');
  return Object.fromEntries(ids.map(id=>{
    const box=parsed[id];
    return [id,Array.isArray(box)&&box.length===4&&box.every(value=>Number.isFinite(value)&&value>=0&&value<=1)&&box[0]<box[2]&&box[1]<box[3]&&area(box)<=MAX_POINT_AREA?box:null];
  }));
}
// The clues to ask about: used in an inference, quoting no text, and with nothing that would be drawn.
export function pointTargets(run){
  const used=usedClueIds(run);
  return run.clues.filter(clue=>used.has(clue.id)&&!hasQuotedText(clue)&&!displayRegions(clue).length);
}
// Adds the stand-in regions to the clues of `run` in place and returns the summary for run.regions.pointing.
// llm: async ({model,reasoningEffort,text,imageBytes,attempt}) => {text,raw}.
export async function pointClues({bytes,run,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{}}){
  const targets=pointTargets(run),summary=pointed=>({version:POINT_VERSION,createdAt:new Date().toISOString(),verification:'none',clues:targets.length,pointed});
  if(!targets.length)return summary(0);
  const prompt=pointPrompt(targets);
  let boxes=null,lastError;
  for(let attempt=1;attempt<=attempts&&!boxes;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,imageBytes:bytes,attempt});
    onCall({stage:'cluePoint',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{boxes=parsePoints(text,targets.map(clue=>clue.id));}catch(error){lastError=error;}
  }
  if(!boxes)throw lastError;
  let pointed=0;
  for(const clue of targets){
    const box=boxes[clue.id];if(!box)continue;
    (clue.regions??=[]).push({id:`${clue.id}-point`,source:POINT_SOURCE,kind:'object',verified:false,bbox:box,query:null,label:null,score:null,point:{version:POINT_VERSION}});
    clue.localization='proposed';pointed++;
  }
  return summary(pointed);
}
