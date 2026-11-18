// MEASUREMENT ONLY, not a paper step. Can the model that reads the clues also say where they are?
// Region linking (paper-regions.mjs) leaves many tier A clues without a box: OCR did not read the text,
// or the detector boxed something else. Here the model is shown the photo and the clues and asked for
// a box per clue ("pointing"). Two checks, neither needing a person:
//   control   clues that already have an OCR text box: how far is the pointed box from it?
//   target    clues without a box: the pointed area is cut out of the photo, enlarged and read by
//             OCR again; if OCR now reads the quoted text there, the box is verified by a tool.
// A person can look at the rest in the viewer (pointed boxes are drawn long-dashed).
//   node scripts/pointing-experiment.mjs prepare --name p1 [--targets 15] [--controls 12]
//   node scripts/pointing-experiment.mjs ask     --name p1 [--handoff <label>]
//   node scripts/pointing-experiment.mjs verify  --name p1 [--write] [--margin 0.15]   (margin: least distance cut out around the box, as a fraction of the photo)
// --write puts the results into the records: the pointed box as a region of kind 'pointed' (never
// counted as located, never painted over), and each OCR line read in the cut-out that matches the
// quoted text as an ordinary text region (source 'paddleocr_crop').
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir,sharp } from '../lib/config.mjs';
import { realAdapters } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { handoffBrief,pendingHandoffs,HANDOFF_PENDING } from '../lib/paper-handoff.mjs';
import { researchProvider } from '../lib/paper-claude.mjs';
import { riskLabels,hasQuotedText } from '../lib/paper-risk.mjs';
import { matchText,boundsOf } from '../lib/paper-regions.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={};
for(let i=0;i<rest.length;i++){const arg=rest[i];if(['--name','--targets','--controls','--handoff','--margin'].includes(arg))flags[arg.slice(2)]=rest[++i];else if(arg.startsWith('--'))flags[arg.slice(2)]=true;}
const usage=()=>{console.error(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(8,11).map(line=>line.replace(/^\/\/ ?/,'')).join('\n'));process.exit(1);};
if(typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name))usage();
const store=new PaperStore(dataDir);
const directory=resolve(store.directory,'pointing');mkdirSync(directory,{recursive:true});
const manifestPath=resolve(directory,`${flags.name}.json`),handoffRoot=resolve(directory,'handoff');
const photos=JSON.parse(readFileSync(resolve(store.directory,'batches','all-photos.json'),'utf8')).photos;
const hashOf=text=>createHash('sha256').update(text).digest('hex');
// Photos looked at first whatever their hash: the two the owner was asked to review for a missing box.
const FIRST=['집_합정 15','학교 6'];

export const pointingPrompt=clues=>[
  'You are given a photo and a list of clues that were extracted from it. Each clue describes something visible in the photo.',
  'For each clue, give the bounding box of the thing in the photo that the clue describes.',
  '- If the clue quotes text, box the quoted text itself, as tightly as you can, not the whole object it is on.',
  '- Otherwise box the single object or structure the clue is about.',
  '- If the clue is about the photo as a whole (weather, season, general style) or you cannot find it, give null.',
  'A box is [x0, y0, x1, y1]: fractions of the image width (x) and height (y) between 0 and 1, three decimals, origin at the top-left corner, x0 < x1 and y0 < y1.',
  'Answer with one JSON object and nothing else, with every clue id as a key:',
  '{"clue-0": [0.120, 0.340, 0.250, 0.390], "clue-1": null}',
  '','Clues:',
  ...clues.map(clue=>`${clue.id}: ${clue.detail}`),
].join('\n');
export function parsePointing(text,ids){
  const fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  const parsed=JSON.parse(fenced??(text.match(/\{[\s\S]*\}/)||[])[0]??text);
  const boxes={};
  for(const id of ids){
    const box=parsed[id];
    boxes[id]=Array.isArray(box)&&box.length===4&&box.every(value=>Number.isFinite(value)&&value>=0&&value<=1)&&box[0]<box[2]&&box[1]<box[3]?box:null;
  }
  return boxes;
}
const iou=(a,b)=>{const w=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),inter=w*h;return inter/((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter);};
const union=boxes=>[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const centre=box=>[(box[0]+box[2])/2,(box[1]+box[3])/2];
const inside=(point,box)=>point[0]>=box[0]&&point[0]<=box[2]&&point[1]>=box[1]&&point[1]<=box[3];

if(command==='prepare'){
  if(existsSync(manifestPath)){console.error('An experiment with this name exists.');process.exit(1);}
  const wantTargets=Number(flags.targets||15),wantControls=Number(flags.controls||12);
  const candidates=photos.map(photo=>{
    const run=store.getRun(photo.runId),marks=riskLabels(run).clues,title=`${photo.folder} ${photo.index}`;
    const targets=run.clues.filter(clue=>marks[clue.id].label!=='low'&&!marks[clue.id].located).map(clue=>clue.id);
    const controls=run.clues.filter(clue=>marks[clue.id].label!=='low'&&hasQuotedText(clue)&&(clue.regions||[]).some(region=>region.kind==='text'&&region.source==='paddleocr')).map(clue=>clue.id);
    return {title,runId:run.id,folder:photo.folder,file:photo.file,targets,controls,order:FIRST.includes(title)?`0${FIRST.indexOf(title)}`:`1${hashOf(run.id)}`};
  }).sort((a,b)=>a.order.localeCompare(b.order));
  const items=[];let targets=0,controls=0;
  for(const candidate of candidates){
    const takeTargets=targets<wantTargets&&candidate.targets.length,takeControls=controls<wantControls&&candidate.controls.length;
    if(!takeTargets&&!takeControls)continue;
    const item={title:candidate.title,runId:candidate.runId,folder:candidate.folder,file:candidate.file,targets:takeTargets?candidate.targets:[],controls:takeControls?candidate.controls:[]};
    targets+=item.targets.length;controls+=item.controls.length;items.push(item);
    if(targets>=wantTargets&&controls>=wantControls)break;
  }
  writeFileSync(manifestPath,JSON.stringify({name:flags.name,createdAt:new Date().toISOString(),first:FIRST,items},null,1));
  console.log(JSON.stringify({experiment:flags.name,photos:items.length,targets,controls}));
  for(const item of items)console.log(JSON.stringify({photo:item.title,targets:item.targets.length,controls:item.controls.length}));
}else if(command==='ask'){
  // The Claude API answers unless --handoff <label> sends the requests to a stand-in through files.
  if(!existsSync(manifestPath))usage();
  const handoff=typeof flags.handoff==='string'?flags.handoff:null,provider=researchProvider(process.env,{handoff,handoffDirectory:handoffRoot}),askModel=provider.stage('regions').model;
  if(!provider.configured(provider.stage('regions'))){console.error(provider.hint);process.exit(1);}
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),llm=provider.llm;
  let answered=0,waiting=0,failed=0;
  for(const item of manifest.items){
    const run=store.getRun(item.runId),ids=[...new Set([...item.targets,...item.controls])];
    const clues=run.clues.filter(clue=>ids.includes(clue.id));
    try{
      const {text}=await llm({model:askModel,text:pointingPrompt(clues),imageBytes:store.image(run.id)});
      try{item.boxes=parsePointing(text,ids);item.model=askModel;answered++;}catch{item.error='unparseable_answer';failed++;}
    }catch(error){if(error.message!==HANDOFF_PENDING)throw error;waiting++;}
  }
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
  console.log(JSON.stringify({step:'ask',answered,waiting,failed}));
  const pending=pendingHandoffs(handoffRoot);
  if(pending.length){console.log(pending.map(request=>request.id).join(' '));console.log(handoffBrief(pending[0].directory));process.exitCode=3;}
}else if(command==='verify'){
  if(!existsSync(manifestPath))usage();
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const total={targets:0,pointed:0,quoting:0,quotingPointed:0,verified:0,controls:0,controlPointed:0,centreInside:0,iouSum:0,iouOver03:0};
  for(const item of manifest.items){
    if(!item.boxes)continue;
    const run=store.getRun(item.runId),stored=store.image(run.id);
    // The original photo has more pixels than the stored analysis image; it is used for the cut-out
    // when it has the same shape once turned upright.
    let source=stored;
    if(item.file){
      const original=await sharp(readFileSync(join(resolve(dataDir,'new-photos'),item.folder,item.file))).rotate().toBuffer({resolveWithObject:true});
      if(Math.abs(original.info.width/original.info.height-run.image.width/run.image.height)<0.01)source=original.data;
    }
    const {width,height}=await sharp(source).metadata();
    item.results={};let changed=false;
    for(const id of item.controls){
      const clue=run.clues.find(candidate=>candidate.id===id),box=item.boxes[id];
      total.controls++;
      if(!box){item.results[id]={role:'control',pointed:false};continue;}
      const reference=union(clue.regions.filter(region=>region.kind==='text'&&region.source==='paddleocr').map(region=>region.bbox));
      const overlap=iou(box,reference),hit=inside(centre(reference),box);
      total.controlPointed++;total.iouSum+=overlap;if(hit)total.centreInside++;if(overlap>=0.3)total.iouOver03++;
      item.results[id]={role:'control',pointed:true,iou:Math.round(overlap*100)/100,ocrCentreInsidePointed:hit};
    }
    for(const id of item.targets){
      const clue=run.clues.find(candidate=>candidate.id===id),box=item.boxes[id],quoting=hasQuotedText(clue);
      total.targets++;if(quoting)total.quoting++;
      if(!box){item.results[id]={role:'target',quoting,pointed:false};continue;}
      total.pointed++;
      const result={role:'target',quoting,pointed:true,area:Math.round((box[2]-box[0])*(box[3]-box[1])*10000)/10000};
      if(quoting){
        total.quotingPointed++;
        // Cut out the pointed area with a margin (a quarter of its size, at least 2% of the photo),
        // enlarge it to 1,400 px on the long side (at most 4x) and read it again.
        const floor=Number(flags.margin||0.02),marginX=Math.max(floor,(box[2]-box[0])*0.25),marginY=Math.max(floor,(box[3]-box[1])*0.25);
        const x0=Math.max(0,box[0]-marginX),y0=Math.max(0,box[1]-marginY),x1=Math.min(1,box[2]+marginX),y1=Math.min(1,box[3]+marginY);
        const left=Math.round(x0*width),top=Math.round(y0*height),w=Math.max(8,Math.round((x1-x0)*width)),h=Math.max(8,Math.round((y1-y0)*height));
        const scale=Math.min(4,Math.max(1,1400/Math.max(w,h)));
        const crop=await sharp(source).extract({left,top,width:Math.min(w,width-left),height:Math.min(h,height-top)}).resize({width:Math.round(w*scale)}).jpeg({quality:95}).toBuffer();
        let lines=[];
        try{lines=(await realAdapters.ocr(crop)).lines;}catch(error){result.ocrError=String(error.message).slice(0,60);}
        const matched=lines.map(line=>({line,hit:clue.textTargets.map(target=>({target,match:matchText(target,line.text)})).find(candidate=>candidate.match)})).filter(entry=>entry.hit);
        result.cropLines=lines.length;result.verified=matched.length>0;result.read=matched.map(entry=>entry.line.text);
        if(result.verified)total.verified++;
        if(flags.write)for(const {line,hit} of matched){
          const regionId=`${clue.id}-ocrcrop-${flags.name}-${line.id}`;
          if((clue.regions||[]).some(region=>region.id===regionId))continue;
          const local=boundsOf(line.polygon),bbox=[x0+local[0]*(x1-x0),y0+local[1]*(y1-y0),x0+local[2]*(x1-x0),y0+local[3]*(y1-y0)];
          (clue.regions??=[]).push({id:regionId,source:'paddleocr_crop',kind:'text',bbox,text:line.text,quoted:hit.target,match:hit.match,score:line.score,pointedBy:item.model});
          clue.localization='proposed';changed=true;
        }
      }
      item.results[id]=result;
    }
    if(flags.write){
      for(const id of [...item.targets,...item.controls]){
        const clue=run.clues.find(candidate=>candidate.id===id),box=item.boxes[id],regionId=`${id}-pointed-${flags.name}`;
        if(!box||(clue.regions||[]).some(region=>region.id===regionId))continue;
        (clue.regions??=[]).push({id:regionId,source:'model_pointing',kind:'pointed',bbox:box,model:item.model,verified:item.results[id]?.verified??null});changed=true;
      }
      if(changed)store.saveRun(run);
    }
    console.log(JSON.stringify({photo:item.title,results:item.results}));
  }
  manifest.verifiedAt=new Date().toISOString();manifest.total={...total,meanIou:total.controlPointed?Math.round(total.iouSum/total.controlPointed*100)/100:null};delete manifest.total.iouSum;
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
  console.log(JSON.stringify(manifest.total));
}else usage();
