// Not a paper step. For quoted text that the vision model read but OCR did not: the model says roughly
// where the text is and how it slants, that area is cut out, enlarged, brightened and turned level,
// and OCR reads it again. Only an OCR line that matches the quoted text (matchText) becomes a region,
// and that region is marked verified. When OCR reads nothing that matches, the model's own box takes
// its place (source 'model_hint', verified false): the clue then has a box, but no tool confirmed that
// the text is there, and the model's boxes are rough. Whoever draws or counts regions can tell the two
// apart by `verified`.
import { sharp } from './config.mjs';
import { matchText,boundsOf } from './paper-regions.mjs';

export const RECHECK_VERSION='text-recheck-v2';
export const RECHECK_SOURCES=['paddleocr_recheck','model_hint'];
export const TEXT_HINT_TEMPLATE=`Below are pieces of text that were read in this photo. For each one, find where it is written in the photo.

For each text give:
- "box": [x0, y0, x1, y1], fractions of the image width (x) and height (y) between 0 and 1, origin at the top-left corner. Cover the whole text; a little too large is better than too small.
- "tilt": the angle of the text's baseline in degrees as it appears in the photo: 0 when level, positive when it rises to the right, negative when it falls to the right. Between -45 and 45.
Give null for a text you cannot find in the photo.

Texts:
<<TEXTS>>

Answer with only this JSON, every key exactly once:
\`\`\`json
{"t0": {"box": [0.120, 0.340, 0.250, 0.390], "tilt": 0}, "t1": null}
\`\`\`
`;
export const textHintPrompt=texts=>TEXT_HINT_TEMPLATE.replace('<<TEXTS>>',()=>texts.map(({key,text})=>`${key}: "${text}"`).join('\n'));

export function parseHints(answer,keys){
  const text=String(answer||'');
  const fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(m=>m[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(text.match(/\{[\s\S]*\}/)||[])[0],text.trim()]){if(!candidate)continue;try{parsed=JSON.parse(candidate);break;}catch{}}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('TEXT_HINTS_INVALID');
  return Object.fromEntries(keys.map(key=>{
    const value=parsed[key],box=value?.box;
    const valid=Array.isArray(box)&&box.length===4&&box.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&box[0]<box[2]&&box[1]<box[3];
    const tilt=Number.isFinite(value?.tilt)&&Math.abs(value.tilt)<=45?value.tilt:0;
    return [key,valid?{box,tilt}:null];
  }));
}

// The model's boxes are rough (pointing experiment p1: mean IoU 0.25 with the OCR box), so the cut-out
// is much larger than the box: half its width on each side and its full height above and below, and
// at least 5% of the photo.
export function cutOut(box,{marginX=0.5,marginY=1,floor=0.05}={}){
  const w=box[2]-box[0],h=box[3]-box[1],mx=Math.max(floor,w*marginX),my=Math.max(floor,h*marginY);
  return [Math.max(0,box[0]-mx),Math.max(0,box[1]-my),Math.min(1,box[2]+mx),Math.min(1,box[3]+my)];
}
// Turns tried, first match wins: level by the model's tilt, as it is, and the tilt 10 degrees either way.
export function variantAngles(tilt){
  const t=Math.round(tilt);
  return [...new Set([t,0,t+10,t-10])].filter(angle=>Math.abs(angle)<=45);
}
// A point of the turned, enlarged cut-out (normalized to it) back to the photo (normalized).
// sharp turns clockwise for a positive angle and grows the canvas to fit.
export function backToPhoto([px,py],{angle,turnedWidth,turnedHeight,enlargedWidth,enlargedHeight,scale,left,top,width,height}){
  const t=angle*Math.PI/180,x=px*turnedWidth-turnedWidth/2,y=py*turnedHeight-turnedHeight/2;
  const ex=x*Math.cos(t)+y*Math.sin(t)+enlargedWidth/2,ey=-x*Math.sin(t)+y*Math.cos(t)+enlargedHeight/2;
  return [Math.max(0,Math.min(1,(ex/scale+left)/width)),Math.max(0,Math.min(1,(ey/scale+top)/height))];
}

// bytes: the analysis image. ocr: async jpeg => {lines:[{id,text,score,polygon}]}. targets: quoted
// strings to look for. maxSide keeps the turned cut-out under 1,024 px, where ocr.py reads it in one
// pass instead of in tiles (one pass ~10 s on CPU, tiles five times that).
// quoted: the string this hint was given for (the fallback region carries it).
export async function readAround({bytes,hint,targets,quoted=null,ocr,maxSide=1000,maxScale=4}){
  const {width,height}=await sharp(bytes).metadata();
  const area=cutOut(hint.box);
  const left=Math.round(area[0]*width),top=Math.round(area[1]*height);
  const w=Math.max(8,Math.min(width-left,Math.round((area[2]-area[0])*width))),h=Math.max(8,Math.min(height-top,Math.round((area[3]-area[1])*height)));
  const tries=[];
  for(const angle of variantAngles(hint.tilt)){
    const t=Math.abs(angle*Math.PI/180),turnedLong=Math.max(w*Math.cos(t)+h*Math.sin(t),w*Math.sin(t)+h*Math.cos(t));
    const scale=Math.max(1,Math.min(maxScale,maxSide/turnedLong));
    const enlarged=await sharp(bytes).extract({left,top,width:w,height:h}).resize({width:Math.round(w*scale),kernel:'lanczos3'}).normalise().png().toBuffer({resolveWithObject:true});
    const turned=await sharp(enlarged.data).rotate(angle,{background:'#000000'}).jpeg({quality:95}).toBuffer({resolveWithObject:true});
    const geometry={angle,turnedWidth:turned.info.width,turnedHeight:turned.info.height,enlargedWidth:enlarged.info.width,enlargedHeight:enlarged.info.height,scale:enlarged.info.width/w,left,top,width,height};
    const started=Date.now(),result=await ocr(turned.data);
    const lines=result.lines.map(line=>({...line,polygon:line.polygon.map(point=>backToPhoto(point,geometry))}));
    const matches=lines.flatMap(line=>{const hit=targets.map(target=>({target,match:matchText(target,line.text)})).find(c=>c.match);return hit?[{line,...hit}]:[];});
    tries.push({angle,scale:Math.round(geometry.scale*100)/100,size:[turned.info.width,turned.info.height],seconds:Math.round((Date.now()-started)/100)/10,read:lines.map(line=>line.text),matched:matches.map(m=>m.line.text)});
    if(matches.length)return {area,tries,verified:true,regions:matches.map(({line,target,match})=>({source:'paddleocr_recheck',kind:'text',verified:true,bbox:boundsOf(line.polygon),polygon:line.polygon,text:line.text,quoted:target,match,score:line.score,recheck:{version:RECHECK_VERSION,angle,scale:Math.round(geometry.scale*100)/100,hint}}))};
  }
  return {area,tries,verified:false,regions:[hintRegion(hint,quoted??targets[0])]};
}
// The model's box standing in for a text region that OCR could not confirm.
export function hintRegion(hint,quoted){
  const [x0,y0,x1,y1]=hint.box;
  return {source:'model_hint',kind:'text',verified:false,bbox:hint.box,polygon:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],text:null,quoted,match:'unverified',score:null,recheck:{version:RECHECK_VERSION,hint}};
}

// One record's worth: every clue that quotes text and has no text region gets the steps above.
// clues are changed in place (regions appended, localization set). HANDOFF_PENDING passes through.
// Returns the summary kept on the record: how many were looked at, read by OCR after all (verified),
// given the model's box instead (standIn), or left without one because the model found no place.
export const needsRecheck=clue=>(clue.textTargets||[]).length>0&&!(clue.regions||[]).some(region=>region.kind==='text');
export async function recheckClues({bytes,clues,model,reasoningEffort=null,llm,ocr,attempts=2,onCall=()=>{}}){
  const targets=clues.filter(needsRecheck),summary={version:RECHECK_VERSION,createdAt:new Date().toISOString(),model,clues:targets.length,verified:0,standIn:0,noHint:0,ocrCalls:0};
  if(!targets.length)return summary;
  const texts=targets.flatMap(clue=>clue.textTargets.map(text=>({clueId:clue.id,text}))).map((entry,index)=>({key:`t${index}`,...entry}));
  const prompt=textHintPrompt(texts);
  let hints=null,lastError;
  for(let attempt=1;attempt<=attempts&&!hints;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,imageBytes:bytes,attempt});
    onCall({stage:'textHints',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{hints=parseHints(text,texts.map(entry=>entry.key));}catch(error){lastError=error;}
  }
  if(!hints)throw lastError;
  for(const clue of targets){
    let regions=[];
    for(const entry of texts.filter(candidate=>candidate.clueId===clue.id)){
      const hint=hints[entry.key];if(!hint)continue;
      const found=await readAround({bytes,hint,targets:clue.textTargets,quoted:entry.text,ocr});
      summary.ocrCalls+=found.tries.length;
      // A line OCR read replaces a stand-in box from an earlier text of the same clue.
      if(found.verified){regions=found.regions;break;}
      if(!regions.length)regions=found.regions;
    }
    if(!regions.length){summary.noHint++;continue;}
    if(regions[0].verified)summary.verified++;else summary.standIn++;
    clue.regions=[...(clue.regions||[]),...regions.map((region,index)=>({id:`${clue.id}-recheck-${index}`,...region}))];
    clue.localization='proposed';
  }
  return summary;
}
