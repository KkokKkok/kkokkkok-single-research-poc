import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { dependency,root,pythonPath,cachePath,sharp } from './config.mjs';
import { jsonSchema,ocrSchema,detectionSchema,cropPixels } from './contracts.mjs';
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const imageInput=bytes=>({type:'input_image',image_url:`data:image/jpeg;base64,${bytes.toString('base64')}`,detail:'high'});
export async function prepareImage(bytes){
  if(bytes.length>10*1024*1024)throw new Error('IMAGE_TOO_LARGE');
  const metadata=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
  if(!['jpeg','png','webp'].includes(metadata.format)||metadata.pages>1)throw new Error('UNSUPPORTED_IMAGE');
  const {data,info}=await sharp(bytes,{limitInputPixels:40_000_000}).rotate().resize(3072,3072,{fit:'inside',withoutEnlargement:true}).flatten({background:'white'}).jpeg({quality:95}).toBuffer({resolveWithObject:true});
  if(data.length>10*1024*1024)throw new Error('IMAGE_TOO_LARGE');
  return {bytes:data,image:{width:info.width,height:info.height,sha256:sha(data),coordinateSpace:'analysis-normalized',bboxFormat:'xyxy',mime:'image/jpeg',metadataRemoved:true}};
}
export function runtimeStatus(){return {model:process.env.OPENAI_MODEL||null,apiConfigured:Boolean(process.env.OPENAI_API_KEY),ocrPythonAvailable:Boolean(workerUrl('ocr'))||existsSync(pythonPath('ocr')),groundingPythonAvailable:Boolean(workerUrl('grounding'))||existsSync(pythonPath('grounding')),segmentation:'not_implemented',promptVersion:'research-cues-v1'};}
// OCR_URL / GROUNDING_URL point at a resident worker (scripts/worker-server.py, one container each).
// Unset, the script is started as a child process for each call, as before.
export const workerUrl=kind=>(process.env[`${kind.toUpperCase()}_URL`]||'').replace(/\/+$/,'')||null;
// Same input and answer as the child process. The OCR image travels as base64 JSON, and KKOK_OCR_*
// values the caller passed as environment travel as per-request settings.
async function runWorker(url,kind,input,extraEnv,timeout){
  const failed=new Error(`${kind.toUpperCase()}_FAILED`);
  try{
    const settings=Object.fromEntries(Object.entries(extraEnv).filter(([name])=>name.startsWith('KKOK_OCR_')));
    const body=kind==='ocr'?JSON.stringify({image:input.toString('base64'),settings}):input;
    const response=await fetch(`${url}/run`,{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(timeout)});
    if(!response.ok)throw failed;
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>16*1024*1024)throw failed;
    return JSON.parse(bytes.toString('utf8'));
  }catch{throw failed;}
}
export function runPython(kind,script,input,extraEnv={},timeout=900000){
  const url=workerUrl(kind);if(url)return runWorker(url,kind,input,extraEnv,timeout);
  const cache=cachePath(kind);mkdirSync(cache,{recursive:true});
  const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_DISABLE_TELEMETRY:'1',HF_HUB_DISABLE_SYMLINKS_WARNING:'1',HF_HOME:cache,...extraEnv};
  if(kind==='ocr')Object.assign(env,{USERPROFILE:cache,PADDLE_PDX_CACHE_HOME:cache,HF_HOME:resolve(cache,'huggingface'),MODELSCOPE_CACHE:resolve(cache,'modelscope'),PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:'True'});
  return new Promise((accept,reject)=>{
    const child=spawn(pythonPath(kind),['-B','-X','utf8',resolve(root,'scripts',script)],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});let chunks=[],size=0,done=false;
    const fail=()=>{if(done)return;done=true;clearTimeout(timer);child.kill();reject(new Error(`${kind.toUpperCase()}_FAILED`));};
    const timer=setTimeout(fail,timeout);child.on('error',fail);child.stdin.on('error',fail);child.stderr.on('data',()=>{});
    child.stdout.on('data',b=>{size+=b.length;if(size>16*1024*1024)fail();else chunks.push(b);});
    child.on('close',code=>{if(done)return;if(code!==0)return fail();try{const out=JSON.parse(Buffer.concat(chunks).toString('utf8'));done=true;clearTimeout(timer);accept(out);}catch{fail();}});
    child.stdin.end(input);
  });
}
export const realAdapters={
  async vlm({model,prompt,schema,name,content,onRaw}){
    if(!process.env.OPENAI_API_KEY||!model)throw new Error('OPENAI_NOT_CONFIGURED');
    const OpenAI=dependency('openai').default;const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:180000,maxRetries:0});
    const r=await client.responses.create({model,store:false,max_output_tokens:24000,input:[{role:'developer',content:prompt},{role:'user',content}],text:{format:{type:'json_schema',name,strict:true,schema:jsonSchema(schema)}}});
    const raw={requestedModel:model,responseModel:r.model,responseId:r.id,status:r.status,usage:r.usage,promptSha256:sha(Buffer.from(prompt)),rawOutputText:r.output_text||''};onRaw(raw);
    if(r.status!=='completed'||!r.output_text)throw new Error('VLM_INCOMPLETE');
    return schema.parse(JSON.parse(r.output_text));
  },
  async ocr(bytes){const r=ocrSchema.parse(await runPython('ocr','ocr.py',bytes));if(new Set(r.lines.map(l=>l.id)).size!==r.lines.length)throw new Error('OCR_DUPLICATE_ID');return r;},
  async detect(bytes,queries){const r=detectionSchema.parse(await runPython('grounding','detect.py',Buffer.from(JSON.stringify({image:bytes.toString('base64'),queries})),{},1800000));if(r.imageSha256!==sha(bytes))throw new Error('DETECTOR_IMAGE_MISMATCH');const seen=new Set();for(const q of r.requests){if(seen.has(q.cueId)||!queries.some(x=>x.cueId===q.cueId&&x.query===q.query))throw new Error('DETECTOR_QUERY_MISMATCH');seen.add(q.cueId);}if(seen.size!==queries.length)throw new Error('DETECTOR_QUERY_MISSING');const ids=r.requests.flatMap(q=>q.detections.map(d=>d.id));if(ids.length!==new Set(ids).size)throw new Error('DETECTOR_DUPLICATE_ID');return r;},
  async crop(bytes,bbox,image){return sharp(bytes).extract(cropPixels(bbox,image.width,image.height)).jpeg({quality:95}).toBuffer();},
  async ocrContext(bytes,lines,image){
    const sheets=[];
    for(let start=0;start<lines.length;start+=8){
      const batch=lines.slice(start,start+8),composites=[];
      for(let i=0;i<batch.length;i++){
        const line=batch[i],xs=line.polygon.map(p=>p[0]),ys=line.polygon.map(p=>p[1]);
        const box=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
        const exact=cropPixels(box,image.width,image.height);
        const mx=Math.max(50,exact.width*.4),my=Math.max(65,exact.height*1.7);
        const leftPx=Math.max(0,Math.floor(exact.left-mx)),topPx=Math.max(0,Math.floor(exact.top-my));
        const context={left:leftPx,top:topPx,width:Math.min(image.width,Math.ceil(exact.left+exact.width+mx))-leftPx,height:Math.min(image.height,Math.ceil(exact.top+exact.height+my))-topPx};
        const marker=Buffer.from(`<svg width="${context.width}" height="${context.height}"><rect x="${exact.left-leftPx}" y="${exact.top-topPx}" width="${exact.width}" height="${exact.height}" fill="none" stroke="#ff3050" stroke-width="2"/></svg>`);
        const crop=await sharp(bytes).extract(context).composite([{input:marker}]).png().toBuffer();
        const display=await sharp(crop).resize(460,250,{fit:'contain',background:'#ffffff'}).jpeg({quality:95}).toBuffer();
        const left=(i%2)*480,top=Math.floor(i/2)*290;
        const safeId=line.id.replace(/[^a-zA-Z0-9_-]/g,'');
        const header=Buffer.from(`<svg width="480" height="30"><rect width="480" height="30" fill="#263d36"/><text x="12" y="22" fill="white" font-size="18" font-family="Arial">${safeId}</text></svg>`);
        composites.push({input:header,left,top},{input:display,left:left+10,top:top+35});
      }
      sheets.push(await sharp({create:{width:960,height:Math.ceil(batch.length/2)*290,channels:3,background:'#e6e9e3'}}).composite(composites).jpeg({quality:95}).toBuffer());
    }
    return sheets;
  },
};
