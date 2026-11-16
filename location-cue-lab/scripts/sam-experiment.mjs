// EXPERIMENT, not a paper step: how long does Segment Anything take per photo on this machine, and
// what do its masks look like for the boxes Grounding DINO found?
// Takes a few records that have detector boxes drawn in the viewer, asks scripts/segment.py for one
// mask per box, and writes each photo with the masks tinted over it (the box dashed around each).
// Nothing is written to the records. Output stays under private-data: the photos can reveal a place.
//   node scripts/sam-experiment.mjs [--photos 5] [--out <dir>]
import { writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir,sharp } from '../lib/config.mjs';
import { runPython } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { displayRegions,CLUE_COLORS } from '../lib/paper-preview.mjs';
import { hasQuotedText } from '../lib/paper-risk.mjs';

const args=process.argv.slice(2),flag=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
const limit=Number(flag('--photos')||5),out=resolve(flag('--out')||resolve(dataDir,'sam-experiment'));
const store=new PaperStore(dataDir);
// The detector boxes the viewer draws by default: best box per phrase, and none for a clue that quotes text.
const objectBoxes=run=>run.clues.flatMap((clue,index)=>hasQuotedText(clue)?[]:displayRegions(clue).filter(region=>region.kind==='object').map((region,n)=>({id:`${clue.id}-${n}`,clue:index+1,query:region.query,bbox:region.bbox})));
const candidates=store.listRuns().filter(run=>['extracted','classified'].includes(run.status)).map(run=>({run,boxes:objectBoxes(run)})).filter(entry=>entry.boxes.length>=2)
  .sort((a,b)=>createHash('sha256').update(a.run.id).digest('hex').localeCompare(createHash('sha256').update(b.run.id).digest('hex'))).slice(0,limit);
// Run lengths (row by row, starting with 0s) to an RGBA layer of the mask's own size.
export function maskLayer({size:[height,width],counts},hex,alpha=150){
  const [r,g,b]=[1,3,5].map(at=>parseInt(hex.slice(at,at+2),16)),pixels=Buffer.alloc(width*height*4);
  let at=0,on=false;
  for(const count of counts){if(on)for(let i=at;i<at+count;i++){pixels[i*4]=r;pixels[i*4+1]=g;pixels[i*4+2]=b;pixels[i*4+3]=alpha;}at+=count;on=!on;}
  return {pixels,width,height,area:counts.filter((_,index)=>index%2).reduce((sum,count)=>sum+count,0)/(width*height)};
}
mkdirSync(out,{recursive:true});
const rows=[];
for(const [index,{run,boxes}] of candidates.entries()){
  const bytes=store.image(run.id),started=Date.now();
  const answer=await runPython('grounding','segment.py',Buffer.from(JSON.stringify({image:bytes.toString('base64'),boxes:boxes.map(({id,bbox})=>({id,bbox}))})));
  const wallMs=Date.now()-started;
  const base=sharp(bytes).resize({width:1100,height:1100,fit:'inside',withoutEnlargement:true}),{data,info}=await base.jpeg({quality:90}).toBuffer({resolveWithObject:true});
  const layers=[],marks=[],detail=[];
  for(const box of boxes){
    const mask=answer.masks.find(candidate=>candidate.id===box.id),color=CLUE_COLORS[(box.clue-1)%CLUE_COLORS.length],layer=maskLayer(mask,color);
    layers.push({input:await sharp(layer.pixels,{raw:{width:layer.width,height:layer.height,channels:4}}).resize(info.width,info.height,{fit:'fill'}).png().toBuffer()});
    const [x0,y0,x1,y1]=box.bbox,x=x0*info.width,y=y0*info.height,boxArea=(x1-x0)*(y1-y0);
    marks.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${((x1-x0)*info.width).toFixed(1)}" height="${((y1-y0)*info.height).toFixed(1)}" fill="none" stroke="#fff" stroke-width="3"/><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${((x1-x0)*info.width).toFixed(1)}" height="${((y1-y0)*info.height).toFixed(1)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="7 4"/><rect x="${x.toFixed(1)}" y="${Math.max(0,y-18).toFixed(1)}" width="${10+8*String(box.clue).length}" height="18" fill="${color}"/><text x="${(x+4).toFixed(1)}" y="${(Math.max(0,y-18)+14).toFixed(1)}" fill="#fff" font-size="13" font-weight="bold" font-family="Arial, sans-serif">${box.clue}</text>`);
    // maskOfBox: how much of the box the mask fills. Low: the box held a lot of background.
    detail.push({clue:box.clue,query:box.query,score:Math.round(mask.score*100)/100,maskOfBox:Math.round(layer.area/boxArea*100)/100,rleNumbers:mask.counts.length,rleBytes:JSON.stringify(mask.counts).length});
  }
  const file=resolve(out,`sam-${index+1}.jpg`);
  writeFileSync(file,await sharp(data).composite([...layers,{input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">${marks.join('')}</svg>`)}]).jpeg({quality:86}).toBuffer());
  rows.push({photo:index+1,runId:run.id,file,wallMs,...answer.timing,model:answer.model,revision:answer.revision,masks:detail});
  console.log(JSON.stringify(rows.at(-1)));
}
writeFileSync(resolve(out,'timing.json'),JSON.stringify({createdAt:new Date().toISOString(),rows},null,1));
