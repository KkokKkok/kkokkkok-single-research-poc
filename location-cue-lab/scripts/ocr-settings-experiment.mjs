// MEASUREMENT, not a paper step. Do other PaddleOCR settings read the texts that got no box?
// Targets: tier A clues that quote text and have no text region (riskLabels: not low, not located).
// Each photo with such a clue is read again with the settings given, and the lines are matched to
// the quoted texts as usual. Also counted, so that a setting which finds more does not quietly lose
// what was found before: the clues of the same photos that already had an OCR text region.
//   node scripts/ocr-settings-experiment.mjs --name s1 [--photos N] [--write] KEY=VALUE ...
//   e.g. KKOK_OCR_DET_BOX_THRESH=0.4 KKOK_OCR_DET_LIMIT_SIDE=1536 KKOK_OCR_DET_LIMIT_TYPE=min
// --write adds each new matching line to its clue as a text region (source 'paddleocr', with the
// settings name), exactly as region linking would have.
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../lib/config.mjs';
import { runPython } from '../lib/adapters.mjs';
import { ocrSchema } from '../lib/contracts.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { riskLabels,hasQuotedText } from '../lib/paper-risk.mjs';
import { matchText,boundsOf } from '../lib/paper-regions.mjs';

const args=process.argv.slice(2),flags={},env={};
for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--name'||arg==='--photos')flags[arg.slice(2)]=args[++i];else if(arg.startsWith('--'))flags[arg.slice(2)]=true;else if(/^KKOK_OCR_[A-Z_]+=/.test(arg)){const [key,...value]=arg.split('=');env[key]=value.join('=');}}
if(typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name)){console.error('node scripts/ocr-settings-experiment.mjs --name s1 [--photos N] [--write] KEY=VALUE ...');process.exit(1);}
const store=new PaperStore(dataDir);
const directory=resolve(store.directory,'ocr-settings');mkdirSync(directory,{recursive:true});
const outPath=resolve(directory,`${flags.name}.json`);
const photos=JSON.parse(readFileSync(resolve(store.directory,'batches','all-photos.json'),'utf8')).photos;
const done=existsSync(outPath)?JSON.parse(readFileSync(outPath,'utf8')):{name:flags.name,createdAt:new Date().toISOString(),settings:env,items:[]};
const candidates=photos.map(photo=>{
  const run=store.getRun(photo.runId),marks=riskLabels(run).clues;
  const quoting=run.clues.filter(clue=>marks[clue.id].label!=='low'&&hasQuotedText(clue));
  return {title:`${photo.folder} ${photo.index}`,runId:run.id,targets:quoting.filter(clue=>!marks[clue.id].located).map(clue=>clue.id),
    controls:quoting.filter(clue=>(clue.regions||[]).some(region=>region.kind==='text'&&region.source==='paddleocr')).map(clue=>clue.id)};
}).filter(candidate=>candidate.targets.length);
for(const candidate of candidates.slice(0,Number(flags.photos||candidates.length))){
  if(done.items.some(item=>item.title===candidate.title))continue;
  const run=store.getRun(candidate.runId),started=Date.now();
  const item={title:candidate.title,runId:run.id,before:run.regions?.ocr?.lineCount??null,targets:{},controls:{}};
  let lines=null;
  try{lines=ocrSchema.parse(await runPython('ocr','ocr.py',store.image(run.id),env,240000)).lines;}catch(error){item.error=String(error.message).slice(0,60);}
  item.seconds=Math.round((Date.now()-started)/1000);
  if(lines){
    item.lines=lines.length;
    let changed=false;
    for(const [role,ids] of [['targets',candidate.targets],['controls',candidate.controls]])for(const id of ids){
      const clue=run.clues.find(entry=>entry.id===id);
      const matched=lines.map(line=>({line,hit:clue.textTargets.map(target=>({target,match:matchText(target,line.text)})).find(entry=>entry.match)})).filter(entry=>entry.hit);
      item[role][id]=matched.map(entry=>entry.line.text);
      if(role==='targets'&&flags.write)for(const {line,hit} of matched){
        const regionId=`${id}-ocr-${flags.name}-${line.id}`;
        if((clue.regions||[]).some(region=>region.id===regionId))continue;
        (clue.regions??=[]).push({id:regionId,source:'paddleocr',settings:flags.name,kind:'text',bbox:boundsOf(line.polygon),polygon:line.polygon,text:line.text,quoted:hit.target,match:hit.match,score:line.score});
        clue.localization='proposed';changed=true;
      }
    }
    if(changed)store.saveRun(run);
  }
  done.items.push(item);writeFileSync(outPath,JSON.stringify(done,null,1));
  console.log(JSON.stringify({photo:item.title,seconds:item.seconds,error:item.error??null,linesBefore:item.before,lines:item.lines??null,targets:item.targets,controlsKept:`${Object.values(item.controls).filter(found=>found.length).length}/${Object.keys(item.controls).length}`}));
}
const read=done.items.filter(item=>!item.error),count=(role,test)=>read.flatMap(item=>Object.values(item[role])).filter(test).length;
done.total={photos:done.items.length,failed:done.items.length-read.length,targets:count('targets',()=>true),targetsFound:count('targets',found=>found.length>0),
  controls:count('controls',()=>true),controlsKept:count('controls',found=>found.length>0),linesBefore:read.reduce((sum,item)=>sum+(item.before??0),0),linesNow:read.reduce((sum,item)=>sum+item.lines,0),
  meanSeconds:read.length?Math.round(read.reduce((sum,item)=>sum+item.seconds,0)/read.length):null,maxSeconds:Math.max(0,...done.items.map(item=>item.seconds))};
writeFileSync(outPath,JSON.stringify(done,null,1));
console.log(JSON.stringify({settings:done.settings,...done.total}));
