// MEASUREMENT ONLY, not a paper step. Quoted text that OCR did not link (no text region on the clue):
// the model says where the text is and how it slants, the area is cut out, enlarged, brightened and
// turned level, and OCR reads it again (paper-text-recheck.mjs). Where OCR still finds nothing, the
// model's box stands in (orange in the pictures, verified:false). Records are not changed.
//   node scripts/text-recheck-experiment.mjs prepare --name r1 [--clues 30]
//   node scripts/text-recheck-experiment.mjs ask     --name r1 [--handoff <label>]
//   node scripts/text-recheck-experiment.mjs verify  --name r1
//   node scripts/text-recheck-experiment.mjs render  --name r1 --out <folder>   (one large image per clue)
// OCR_URL (a local scripts/worker-server.py ocr) keeps the OCR model loaded between the cut-outs.
import { readFileSync,writeFileSync,existsSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir,sharp } from '../lib/config.mjs';
import { realAdapters } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { handoffBrief,pendingHandoffs,HANDOFF_PENDING } from '../lib/paper-handoff.mjs';
import { researchProvider } from '../lib/paper-claude.mjs';
import { textHintPrompt,parseHints,readAround,hintRegion } from '../lib/paper-text-recheck.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={};
for(let i=0;i<rest.length;i++){const arg=rest[i];if(['--name','--clues','--handoff','--out'].includes(arg))flags[arg.slice(2)]=rest[++i];else if(arg.startsWith('--'))flags[arg.slice(2)]=true;}
const usage=()=>{console.error(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(4,8).map(line=>line.replace(/^\/\/ ?/,'')).join('\n'));process.exit(1);};
if(typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name))usage();
const store=new PaperStore(dataDir);
const directory=resolve(store.directory,'text-recheck');mkdirSync(directory,{recursive:true});
const manifestPath=resolve(directory,`${flags.name}.json`),handoffRoot=resolve(directory,'handoff'),imageDir=resolve(directory,flags.name);
const photos=JSON.parse(readFileSync(resolve(store.directory,'batches','all-photos.json'),'utf8')).photos;
const hashOf=text=>createHash('sha256').update(text).digest('hex');
const unlinked=clue=>clue.textTargets?.length&&!(clue.regions||[]).some(region=>region.kind==='text');

if(command==='prepare'){
  if(existsSync(manifestPath)){console.error('An experiment with this name exists.');process.exit(1);}
  const want=Number(flags.clues||30);
  const all=photos.flatMap(photo=>{const run=store.getRun(photo.runId);return run?.regions?run.clues.filter(unlinked).map(clue=>({title:`${photo.folder} ${photo.index}`,runId:run.id,clueId:clue.id,order:hashOf(`${run.id}/${clue.id}`)})):[];})
    .sort((a,b)=>a.order.localeCompare(b.order)).slice(0,want);
  const items=[];
  for(const entry of all){let item=items.find(i=>i.runId===entry.runId);if(!item)items.push(item={title:entry.title,runId:entry.runId,clues:[]});item.clues.push(entry.clueId);}
  writeFileSync(manifestPath,JSON.stringify({name:flags.name,createdAt:new Date().toISOString(),items},null,1));
  console.log(JSON.stringify({experiment:flags.name,photos:items.length,clues:all.length}));
}else if(command==='ask'){
  // The Claude API answers unless --handoff <label> sends the requests to a stand-in through files.
  if(!existsSync(manifestPath))usage();
  const handoff=typeof flags.handoff==='string'?flags.handoff:null,provider=researchProvider(process.env,{handoff,handoffDirectory:handoffRoot}),askModel=provider.stage('regions').model;
  if(!provider.configured(provider.stage('regions'))){console.error(provider.hint);process.exit(1);}
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8')),llm=provider.llm;
  let answered=0,waiting=0,failed=0;
  for(const item of manifest.items){
    const run=store.getRun(item.runId);
    item.texts=item.clues.flatMap(id=>run.clues.find(clue=>clue.id===id).textTargets.map(text=>({clueId:id,text}))).map((entry,index)=>({key:`t${index}`,...entry}));
    try{
      const {text}=await llm({model:askModel,text:textHintPrompt(item.texts),imageBytes:store.image(run.id)});
      try{item.hints=parseHints(text,item.texts.map(entry=>entry.key));item.model=askModel;answered++;}catch{item.error='unparseable_answer';failed++;}
    }catch(error){if(error.message!==HANDOFF_PENDING)throw error;waiting++;}
  }
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
  console.log(JSON.stringify({step:'ask',answered,waiting,failed}));
  const pending=pendingHandoffs(handoffRoot);
  if(pending.length){console.log(pending.map(request=>request.directory).join('\n'));console.log(handoffBrief(pending[0].directory));process.exitCode=3;}
}else if(command==='verify'){
  if(!existsSync(manifestPath))usage();
  mkdirSync(imageDir,{recursive:true});
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const total={clues:0,hinted:0,linked:0,fallback:0,ocrCalls:0,seconds:0};const panels=[];
  for(const item of manifest.items){
    if(!item.hints)continue;
    const run=store.getRun(item.runId),bytes=store.image(run.id);
    item.results={};
    for(const clueId of item.clues){
      const clue=run.clues.find(c=>c.id===clueId),texts=item.texts.filter(entry=>entry.clueId===clueId);
      total.clues++;
      const result={quoted:clue.textTargets,tries:[],regions:[]};
      for(const entry of texts){
        const hint=item.hints[entry.key];if(!hint)continue;
        result.hint??=hint;
        const found=await readAround({bytes,hint,targets:clue.textTargets,quoted:entry.text,ocr:realAdapters.ocr});
        result.tries.push(...found.tries.map(t=>({text:entry.text,...t})));result.area??=found.area;
        // A verified OCR line replaces any stand-in box; otherwise the first stand-in is kept.
        if(found.verified){result.regions=found.regions;break;}
        if(!result.regions.length)result.regions=found.regions;
      }
      if(result.hint)total.hinted++;
      if(result.regions.some(r=>r.verified))total.linked++;else if(result.regions.length)total.fallback++;
      total.ocrCalls+=result.tries.length;total.seconds+=result.tries.reduce((n,t)=>n+t.seconds,0);
      item.results[clueId]=result;
      console.log(JSON.stringify({photo:item.title,clue:clueId,quoted:clue.textTargets,hint:Boolean(result.hint),linked:result.regions.filter(r=>r.verified).map(r=>r.text),fallback:result.regions.some(r=>!r.verified),tries:result.tries.map(t=>`${t.angle}°:${t.read.join('/')||'-'}`)}));
      panels.push(await panel({bytes,title:`${item.title} ${clueId}`,result}));
    }
  }
  // Sheets of six panels for a person to look at.
  for(let start=0;start<panels.length;start+=6){
    const group=panels.slice(start,start+6),sheet=sharp({create:{width:1220,height:Math.ceil(group.length/2)*610,channels:3,background:'#111'}});
    await sheet.composite(group.map((input,i)=>({input,left:(i%2)*610+5,top:Math.floor(i/2)*610+5}))).jpeg({quality:88}).toFile(resolve(imageDir,`sheet-${String(start/6+1).padStart(2,'0')}.jpg`));
  }
  manifest.verifiedAt=new Date().toISOString();manifest.total={...total,seconds:Math.round(total.seconds)};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
  console.log(JSON.stringify(manifest.total));
}else if(command==='render'){
  // One large image per clue from a verified experiment, for a report: --out <folder>.
  if(!existsSync(manifestPath)||typeof flags.out!=='string')usage();
  const out=resolve(flags.out);mkdirSync(out,{recursive:true});
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));let n=0;
  for(const item of manifest.items)for(const clueId of item.clues){
    const result=item.results?.[clueId];if(!result)continue;
    for(const region of result.regions)region.verified??=region.source==='paddleocr_recheck';
    if(!result.regions.length&&result.hint){const entry=item.texts.find(t=>t.clueId===clueId&&item.hints[t.key]);result.regions=[hintRegion(result.hint,entry.text)];}
    const file=`${String(++n).padStart(2,'0')}-${result.regions.some(r=>r.verified)?'linked':result.regions.length?'fallback':'nohint'}.jpg`;
    await sharp(await panel({bytes:store.image(item.runId),title:`${item.title} ${clueId}`,result,S:1200})).jpeg({quality:88}).toFile(resolve(out,file));
    console.log(JSON.stringify({file,photo:item.title,clue:clueId,box:result.regions[0]?.bbox.map(v=>Math.round(v*1000)/1000)??null}));
  }
  writeFileSync(manifestPath,JSON.stringify(manifest,null,1));
}else usage();

// One square panel (S px): the cut-out area, the model's hint (yellow, dashed) and what OCR linked (green).
async function panel({bytes,title,result,S=600}){
  const esc=text=>String(text).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const {width,height}=await sharp(bytes).metadata(),k=S/600,head=Math.round(80*k);
  const area=result.area??[0,0,1,1],left=Math.round(area[0]*width),top=Math.round(area[1]*height);
  const w=Math.max(8,Math.min(width-left,Math.round((area[2]-area[0])*width))),h=Math.max(8,Math.min(height-top,Math.round((area[3]-area[1])*height))),scale=Math.min(S/w,(S-head)/h);
  const img=await sharp(bytes).extract({left,top,width:w,height:h}).resize({width:Math.max(1,Math.round(w*scale))}).toBuffer();
  const px=([x,y])=>`${((x*width-left)*scale).toFixed(1)},${((y*height-top)*scale+head).toFixed(1)}`;
  const shapes=[];
  if(result.hint&&!result.regions.some(r=>!r.verified)){const b=result.hint.box;shapes.push(`<polygon points="${[[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]].map(px).join(' ')}" fill="none" stroke="#ffd60a" stroke-width="${3*k}" stroke-dasharray="${10*k} ${7*k}"/>`);}
  const verified=result.regions.some(r=>r.verified),standIn=!verified&&result.regions.length>0;
  for(const region of result.regions)shapes.push(`<polygon points="${region.polygon.map(px).join(' ')}" fill="none" stroke="${region.verified?'#19c37d':'#ff9f0a'}" stroke-width="${4*k}"/>`);
  const last=result.tries.at(-1),status=verified?`연결됨: "${result.regions[0].text}" (${result.regions[0].recheck.angle}°)`:standIn?`모델 상자로 대체 (OCR 확인 안 됨) · OCR: ${(last?.read||[]).slice(0,2).join(' / ')||'(없음)'}`:'모델이 위치를 못 짚음: 상자 없음';
  const svg=`<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg"><rect width="${S}" height="${head}" fill="${verified?'#14532d':standIn?'#92400e':'#7f1d1d'}"/>
<text x="${10*k}" y="${24*k}" font-family="Malgun Gothic" font-size="${18*k}" fill="#fff">${esc(`${title} · "${String(result.quoted[0]).slice(0,30)}"`)}</text>
<text x="${10*k}" y="${52*k}" font-family="Malgun Gothic" font-size="${17*k}" fill="#fff">${esc(status.slice(0,60))}</text>
<text x="${10*k}" y="${74*k}" font-family="Malgun Gothic" font-size="${14*k}" fill="#ddd">시도 ${result.tries.length}회 · ${result.tries.map(t=>t.angle+'°').join(' ')}</text>${shapes.join('')}</svg>`;
  return sharp({create:{width:S,height:S,channels:3,background:'#222'}}).composite([{input:img,left:0,top:head},{input:Buffer.from(svg),left:0,top:0}]).png().toBuffer();
}
