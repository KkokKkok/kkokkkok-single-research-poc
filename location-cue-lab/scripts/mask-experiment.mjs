// EVALUATION ONLY, and not a paper step in this form (the paper masked clues by hand). Does hiding
// the clues the pipeline marks actually stop the location from coming out?
// For photos whose place was found (by the address guess or by a map search), the boxes of the marked
// clues are painted over and the two attacks are run again on the painted photo:
//   the address guess   (the paper's CoT prompt, `locate`)
//   the map search      (the Detector reads the photo again, its quoted texts go to the place search)
// Two variants per photo:
//   confirmed   only the clues labelled 확인된 위험 are painted over
//   risk        the clues labelled 확인된 위험 or 잠재 위험 are painted over
// Painted photos live in their own store (private-data/mask-experiment), apart from the real records.
//   node scripts/mask-experiment.mjs prepare --name m1 [--photos 12] [--only "title,title"]
//   node scripts/mask-experiment.mjs locate  --name m1 [--handoff <label>]
//   node scripts/mask-experiment.mjs extract --name m1 [--handoff <label>]
// The model is the Claude API (lib/paper-claude.mjs researchProvider); --handoff sends the requests to a stand-in through files.
//   node scripts/mask-experiment.mjs score   --name m1
// No coordinate is printed or written: only distances.
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir,sharp } from '../lib/config.mjs';
import { prepareImage } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { paperStages } from '../lib/paper-llm.mjs';
import { researchProvider } from '../lib/paper-claude.mjs';
import { handoffBrief,pendingHandoffs } from '../lib/paper-handoff.mjs';
import { extractImage,locateRun,scoreRun,searchPlacesRun } from '../lib/paper-runner.mjs';
import { GEOCODERS,DEFAULT_RADIUS_M,naverPlaceSearch } from '../lib/paper-score.mjs';
import { parseGps } from '../lib/location-experiment.mjs';
import { displayRegions } from '../lib/paper-preview.mjs';
import { riskLabels,hasQuotedText } from '../lib/paper-risk.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={};
for(let i=0;i<rest.length;i++){const arg=rest[i];if(['--name','--photos','--handoff','--only'].includes(arg))flags[arg.slice(2)]=rest[++i];else if(arg.startsWith('--'))flags[arg.slice(2)]=true;}
const usage=()=>{console.error(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(11,16).map(line=>line.replace(/^\/\/ ?/,'')).join('\n'));process.exit(1);};
if(typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name))usage();
const store=new PaperStore(dataDir),maskStore=new PaperStore(resolve(dataDir,'mask-experiment'));
const manifestPath=resolve(maskStore.directory,`${flags.name}.json`);
const photos=JSON.parse(readFileSync(resolve(store.directory,'batches','all-photos.json'),'utf8')).photos;
const root=resolve(dataDir,'new-photos');
const truthOf=async photo=>photo.file?parseGps((await sharp(readFileSync(join(root,photo.folder,photo.file))).metadata()).exif):{status:'missing'};
const MAX_BOX_AREA=0.4;
// The boxes that would be painted over for one clue: what the viewer draws for it by default (a text
// line read by OCR for a clue that quotes text, the best object box otherwise), but nothing that
// covers more than MAX_BOX_AREA of the photo — painting that over would hide the whole picture.
const maskBoxes=clue=>displayRegions(clue).filter(region=>hasQuotedText(clue)?region.kind==='text':true).map(region=>region.bbox).filter(box=>(box[2]-box[0])*(box[3]-box[1])<=MAX_BOX_AREA);
async function paint(bytes,boxes){
  const {width,height}=await sharp(bytes).metadata();
  const rects=boxes.map(([x0,y0,x1,y1])=>{
    const padX=Math.max(6,(x1-x0)*width*0.08),padY=Math.max(6,(y1-y0)*height*0.08);
    const x=Math.max(0,x0*width-padX),y=Math.max(0,y0*height-padY),w=Math.min(width-x,(x1-x0)*width+2*padX),h=Math.min(height-y,(y1-y0)*height+2*padY);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#000"/>`;
  }).join('');
  return sharp(bytes).composite([{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`)}]).jpeg({quality:95}).toBuffer();
}
const handoff=typeof flags.handoff==='string'?flags.handoff:null;
const provider=researchProvider(process.env,{handoff,handoffDirectory:maskStore.handoffDirectory}),llm=provider.llm;
const listPending=()=>{const waiting=pendingHandoffs(maskStore.handoffDirectory);console.log(JSON.stringify({pending:waiting.length}));if(waiting.length){console.log(waiting.map(request=>request.id).join(' '));console.log(handoffBrief(waiting[0].directory));}return waiting.length;};

if(command==='prepare'){
  if(existsSync(manifestPath)){console.error('An experiment with this name exists.');process.exit(1);}
  const limit=Number(flags.photos||12),candidates=[];
  for(const photo of photos){
    if(!photo.file)continue;
    const run=store.getRun(photo.runId);
    const guess=(run.predictions||[]).at(-1),guessHit=guess?.score?.withinRadius===true,searchHit=(run.placeSearches||[]).some(single=>single.topWithinRadius);
    if(!guessHit&&!searchHit)continue;                      // the place did not come out: nothing to stop
    const marks=riskLabels(run).clues;
    const boxesOf=labels=>run.clues.filter(clue=>labels.includes(marks[clue.id].label)).map(clue=>({clueId:clue.id,boxes:maskBoxes(clue)})).filter(entry=>entry.boxes.length);
    const confirmed=boxesOf(['confirmed']),risk=boxesOf(['confirmed','potential']);
    if(!risk.length)continue;                               // nothing the pipeline could paint over
    candidates.push({photo,run,guessHit,searchHit,confirmed,risk,order:createHash('sha256').update(run.id).digest('hex')});
  }
  candidates.sort((a,b)=>a.order.localeCompare(b.order));
  // --only "집_당산 17,학교 2": just these photos (to repeat a photo after a rule change).
  if(typeof flags.only==='string'){const wanted=flags.only.split(',').map(title=>title.trim());candidates.splice(0,candidates.length,...candidates.filter(candidate=>wanted.includes(`${candidate.photo.folder} ${candidate.photo.index}`)));}
  const stages=paperStages(process.env,{handoffModel:'pending'}),items=[];
  for(const candidate of candidates.slice(0,limit)){
    const {photo,run}=candidate,marks=riskLabels(run).clues;
    const variants=[];
    for(const [variant,entries] of [['confirmed',candidate.confirmed],['risk',candidate.risk]]){
      // The confirmed variant is skipped when it would paint the same boxes as the risk variant, or none.
      if(!entries.length||(variant==='confirmed'&&entries.length===candidate.risk.length))continue;
      const boxes=entries.flatMap(entry=>entry.boxes);
      const prepared=await prepareImage(await paint(store.image(run.id),boxes));
      const masked=maskStore.registerRun(prepared.image,prepared.bytes,stages);
      variants.push({variant,runId:masked.id,maskedClueIds:entries.map(entry=>entry.clueId),boxes:boxes.length});
    }
    items.push({title:`${photo.folder} ${photo.index}`,sourceRunId:run.id,folder:photo.folder,file:photo.file,guessHit:candidate.guessHit,searchHit:candidate.searchHit,
      labelled:{confirmed:run.clues.filter(clue=>marks[clue.id].label==='confirmed').length,potential:run.clues.filter(clue=>marks[clue.id].label==='potential').length},
      // Marked clues that have no box and so stay visible in the painted photo.
      unmaskable:{confirmed:run.clues.filter(clue=>marks[clue.id].label==='confirmed'&&!maskBoxes(clue).length).map(clue=>clue.id),potential:run.clues.filter(clue=>marks[clue.id].label==='potential'&&!maskBoxes(clue).length).map(clue=>clue.id)},variants});
  }
  writeFileSync(manifestPath,JSON.stringify({name:flags.name,createdAt:new Date().toISOString(),candidates:candidates.length,maxBoxArea:MAX_BOX_AREA,items},null,1));
  console.log(JSON.stringify({experiment:flags.name,candidates:candidates.length,photos:items.length,variants:items.reduce((sum,item)=>sum+item.variants.length,0),guessHit:items.filter(item=>item.guessHit).length,searchHit:items.filter(item=>item.searchHit).length}));
  for(const item of items)console.log(JSON.stringify({photo:item.title,guessHit:item.guessHit,searchHit:item.searchHit,labelled:item.labelled,unmaskable:{confirmed:item.unmaskable.confirmed.length,potential:item.unmaskable.potential.length},variants:item.variants.map(variant=>`${variant.variant}:${variant.boxes}`)}));
}else if(command==='locate'||command==='extract'){
  if(!existsSync(manifestPath))usage();
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const stage=provider.stage('locator'),stages=provider.stages;
  if(!provider.configured(stage)){console.error(provider.hint);process.exit(1);}
  const count={};
  for(const item of manifest.items)for(const variant of item.variants){
    let run=maskStore.getRun(variant.runId);
    if(command==='locate')run=await locateRun({store:maskStore,run,stage,llm});
    else if(run.status==='registered'||run.status==='pending')run=await extractImage({store:maskStore,prepared:{bytes:maskStore.image(run.id),image:run.image},stages,llm,run,detectorPrompt:provider.detectorPrompt});
    const state=run.pending?'pending':command==='locate'?((run.predictions||[]).length?'answered':'none'):run.status;
    count[state]=(count[state]||0)+1;
  }
  console.log(JSON.stringify({step:command,...count}));
  if(listPending())process.exitCode=3;
}else if(command==='score'){
  if(!existsSync(manifestPath))usage();
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  for(const item of manifest.items){
    const truth=await truthOf(item);
    if(truth.status!=='found'){item.error='no_truth';continue;}
    const source=store.getRun(item.sourceRunId),baseGuess=(source.predictions||[]).at(-1);
    item.before={guessDistanceM:baseGuess?.score?.distanceM==null?null:Math.round(baseGuess.score.distanceM),guessHit:baseGuess?.score?.withinRadius===true,
      revealingTexts:(source.placeSearches||[]).filter(single=>single.topWithinRadius).map(single=>single.query)};
    for(const variant of item.variants){
      let run=maskStore.getRun(variant.runId);
      const scored=await scoreRun({store:maskStore,run,truth,geocoder:'naver',geocode:GEOCODERS.naver.geocode,radiusM:DEFAULT_RADIUS_M,matchesPaperGeocoder:false,force:true});
      if(scored.blocked){console.log(JSON.stringify({status:'geocoder_unavailable',reason:scored.blocked}));process.exit(2);}
      run=scored.run;
      if(['extracted','classified'].includes(run.status)){
        const searched=await searchPlacesRun({store:maskStore,run,truth,search:naverPlaceSearch,radiusM:DEFAULT_RADIUS_M,force:true});
        if(searched.blocked){console.log(JSON.stringify({status:'place_search_unavailable',reason:searched.blocked}));process.exit(2);}
        run=searched.run;
      }
      const guess=(run.predictions||[]).at(-1);
      variant.after={guess:guess?.status??'none',guessScore:guess?.score?.status??null,guessDistanceM:guess?.score?.distanceM==null?null:Math.round(guess.score.distanceM),guessHit:guess?.score?.withinRadius===true,
        extracted:['extracted','classified'].includes(run.status),clues:run.clues.length,searchedTexts:run.placeSearches?.length??null,revealingTexts:(run.placeSearches||[]).filter(single=>single.topWithinRadius).map(single=>single.query)};
      console.log(JSON.stringify({photo:item.title,variant:variant.variant,boxes:variant.boxes,before:item.before,after:variant.after}));
    }
  }
  manifest.scoredAt=new Date().toISOString();
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
}else usage();
