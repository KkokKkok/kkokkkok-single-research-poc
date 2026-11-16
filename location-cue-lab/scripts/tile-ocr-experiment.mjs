// MEASUREMENT, not a paper step. Does OCR read more when it is given more pixels?
// Region linking reads the analysis image (long side 1,024). A tier A clue that quotes text gets no
// box when OCR does not read that text there. Here the same OCR reads, for each such photo:
//   whole   the original photo at its full size, once
//   tiles   the original cut into 2 x 2 overlapping tiles (each 60% of the width and height)
// and the lines are matched to the quoted texts as usual (paper-regions.mjs matchText). No model is
// involved. Photos without an original on disk use the stored analysis image, enlarged twice.
//   node scripts/tile-ocr-experiment.mjs run --name t1 [--photos 15] [--write]
// --write adds every matching line to its clue as an ordinary text region (source 'paddleocr_tile').
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir,sharp } from '../lib/config.mjs';
import { realAdapters } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { riskLabels,hasQuotedText } from '../lib/paper-risk.mjs';
import { matchText,boundsOf } from '../lib/paper-regions.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={};
for(let i=0;i<rest.length;i++){const arg=rest[i];if(['--name','--photos'].includes(arg))flags[arg.slice(2)]=rest[++i];else if(arg.startsWith('--'))flags[arg.slice(2)]=true;}
if(command!=='run'||typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name)){console.error('node scripts/tile-ocr-experiment.mjs run --name t1 [--photos 15] [--write]');process.exit(1);}
const store=new PaperStore(dataDir);
const directory=resolve(store.directory,'tile-ocr');mkdirSync(directory,{recursive:true});
const outPath=resolve(directory,`${flags.name}.json`);
const photos=JSON.parse(readFileSync(resolve(store.directory,'batches','all-photos.json'),'utf8')).photos;
const FIRST=['집_합정 15','학교 6'];
const TILE=0.6,STARTS=[0,1-TILE];
const done=existsSync(outPath)?JSON.parse(readFileSync(outPath,'utf8')):{name:flags.name,createdAt:new Date().toISOString(),tile:TILE,items:[]};

const candidates=photos.map(photo=>{
  const run=store.getRun(photo.runId),marks=riskLabels(run).clues,title=`${photo.folder} ${photo.index}`;
  const targets=run.clues.filter(clue=>marks[clue.id].label!=='low'&&!marks[clue.id].located&&hasQuotedText(clue)).map(clue=>clue.id);
  return {title,photo,runId:run.id,targets,order:FIRST.includes(title)?`0${FIRST.indexOf(title)}`:`1${createHash('sha256').update(run.id).digest('hex')}`};
}).filter(candidate=>candidate.targets.length).sort((a,b)=>a.order.localeCompare(b.order));
console.log(JSON.stringify({photosWithTargets:candidates.length,targetClues:candidates.reduce((sum,candidate)=>sum+candidate.targets.length,0)}));

for(const candidate of candidates.slice(0,Number(flags.photos||15))){
  if(done.items.some(item=>item.title===candidate.title))continue;
  const run=store.getRun(candidate.runId),started=Date.now();
  let source,origin='analysis_x2';
  if(candidate.photo.file){
    const original=await sharp(readFileSync(join(resolve(dataDir,'new-photos'),candidate.photo.folder,candidate.photo.file))).rotate().jpeg({quality:95}).toBuffer({resolveWithObject:true});
    if(Math.abs(original.info.width/original.info.height-run.image.width/run.image.height)<0.01){source=original.data;origin='original';}
  }
  if(!source)source=await sharp(store.image(run.id)).resize({width:run.image.width*2}).jpeg({quality:95}).toBuffer();
  const {width,height}=await sharp(source).metadata();
  // Each pass: the area it covers (fractions of the photo) and the lines OCR read in it.
  const passes=[{name:'whole',area:[0,0,1,1]},...STARTS.flatMap((y,row)=>STARTS.map((x,column)=>({name:`tile-${row}${column}`,area:[x,y,x+TILE,y+TILE]})))];
  const item={title:candidate.title,runId:run.id,origin,width,height,clues:{},errors:[]};
  for(const id of candidate.targets)item.clues[id]={whole:[],tiles:[]};
  let changed=false;
  for(const pass of passes){
    const [x0,y0,x1,y1]=pass.area,left=Math.round(x0*width),top=Math.round(y0*height);
    const bytes=pass.name==='whole'?source:await sharp(source).extract({left,top,width:Math.min(Math.round((x1-x0)*width),width-left),height:Math.min(Math.round((y1-y0)*height),height-top)}).jpeg({quality:95}).toBuffer();
    let lines=[];
    try{lines=(await realAdapters.ocr(bytes)).lines;}catch(error){item.errors.push({pass:pass.name,error:String(error.message).slice(0,80)});continue;}
    for(const id of candidate.targets){
      const clue=run.clues.find(entry=>entry.id===id);
      for(const line of lines){
        const hit=clue.textTargets.map(target=>({target,match:matchText(target,line.text)})).find(entry=>entry.match);
        if(!hit)continue;
        item.clues[id][pass.name==='whole'?'whole':'tiles'].push({pass:pass.name,text:line.text,match:hit.match});
        if(flags.write){
          const regionId=`${id}-ocrtile-${flags.name}-${pass.name}-${line.id}`;
          if((clue.regions||[]).some(region=>region.id===regionId))continue;
          const local=boundsOf(line.polygon),bbox=[x0+local[0]*(x1-x0),y0+local[1]*(y1-y0),x0+local[2]*(x1-x0),y0+local[3]*(y1-y0)];
          (clue.regions??=[]).push({id:regionId,source:'paddleocr_tile',kind:'text',bbox,text:line.text,quoted:hit.target,match:hit.match,score:line.score,pass:pass.name,readFrom:origin});
          clue.localization='proposed';changed=true;
        }
      }
    }
  }
  if(changed)store.saveRun(run);
  item.seconds=Math.round((Date.now()-started)/1000);
  done.items.push(item);writeFileSync(outPath,JSON.stringify(done,null,1));
  console.log(JSON.stringify({photo:item.title,origin,size:`${width}x${height}`,seconds:item.seconds,errors:item.errors.length,
    clues:Object.fromEntries(Object.entries(item.clues).map(([id,found])=>[id,{whole:found.whole.length,tiles:found.tiles.length,read:[...new Set([...found.whole,...found.tiles].map(entry=>entry.text))].slice(0,3)}]))}));
}
const all=done.items.flatMap(item=>Object.values(item.clues));
done.total={photos:done.items.length,clues:all.length,byWhole:all.filter(found=>found.whole.length).length,byTiles:all.filter(found=>found.tiles.length).length,byEither:all.filter(found=>found.whole.length||found.tiles.length).length,
  meanSeconds:done.items.length?Math.round(done.items.reduce((sum,item)=>sum+item.seconds,0)/done.items.length):null};
writeFileSync(outPath,JSON.stringify(done,null,1));
console.log(JSON.stringify(done.total));
