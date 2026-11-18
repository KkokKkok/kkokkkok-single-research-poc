import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root,dataDir,z } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { prepareImage,runtimeStatus } from './lib/adapters.mjs';
import { runPipeline } from './lib/pipeline.mjs';
import { boxSchema } from './lib/contracts.mjs';

export function createApp({directory=dataDir,adapters,requireConfiguration=true}={}){
  const store=new Store(directory);store.recover();const token=randomBytes(32).toString('hex');let working=false,closing=false;
  async function pump(){if(working||closing)return;working=true;try{let row;while(!closing&&(row=store.list().reverse().find(x=>x.status==='queued'))){try{await runPipeline(store,row.id,adapters);}catch{const r=store.get(row.id);r.status='partial';r.errors.push({stage:'pipeline',code:'PIPELINE_FAILED'});store.save(r);}}}finally{working=false;}}
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  async function body(req,limit){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>limit){const e=new Error('REQUEST_TOO_LARGE');e.status=413;throw e;}chunks.push(part);}return Buffer.concat(chunks);}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    try{
      const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))return json(res,403,{error:'LOCAL_ONLY'});
      if(req.headers.origin&&req.headers.origin!==`http://${host}`)return json(res,403,{error:'ORIGIN_REJECTED'});
      if(!['GET','HEAD'].includes(req.method)&&req.headers['x-cue-token']!==token)return json(res,403,{error:'TOKEN_REQUIRED'});
      const url=new URL(req.url,`http://${host}`);const path=url.pathname;
      if(req.method==='GET'&&path==='/api/config')return json(res,200,{...runtimeStatus(),token});
      if(req.method==='GET'&&path==='/api/analyses')return json(res,200,store.list());
      if(req.method==='POST'&&path==='/api/analyses'){
        if(requireConfiguration&&(!process.env.OPENAI_API_KEY||!process.env.OPENAI_MODEL))return json(res,409,{error:'OPENAI_NOT_CONFIGURED'});
        if(store.list().filter(x=>['queued','running'].includes(x.status)).length>=20)return json(res,429,{error:'QUEUE_FULL'});
        const prepared=await prepareImage(await body(req,10*1024*1024));const r=store.create(prepared.image,prepared.bytes,process.env.OPENAI_MODEL||'fixture-model');
        json(res,202,{id:r.id,status:r.status});void pump();return;
      }
      const match=path.match(/^\/api\/analyses\/([0-9a-f-]{36})(?:\/(image|export|retry|reviews))?$/);
      if(match){const [,id,action]=match;const r=store.get(id);if(!r)return json(res,404,{error:'NOT_FOUND'});
        if(req.method==='GET'&&action==='image'){res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(store.image(id));return;}
        if(req.method==='GET'&&action==='export'){res.setHeader('Content-Disposition',`attachment; filename="cues-${id}.json"`);return json(res,200,r);}
        if(req.method==='GET'&&!action)return json(res,200,r);
        if(req.method==='POST'&&action==='retry'){
          if(!['failed','partial'].includes(r.status))return json(res,409,{error:'NOT_RETRYABLE'});
          r.status='queued';store.save(r);json(res,202,{id,status:r.status});void pump();return;
        }
        if(req.method==='POST'&&action==='reviews'){
          if(['running','queued'].includes(r.status))return json(res,409,{error:'ANALYSIS_RUNNING'});
          const input=z.object({cueId:z.string(),status:z.enum(['accepted','rejected','uncertain','unreviewed']),note:z.string().max(2000),bbox:boxSchema.nullable(),expectedUpdatedAt:z.string()}).strict().parse(JSON.parse((await body(req,16000)).toString('utf8')));
          if(r.updatedAt!==input.expectedUpdatedAt)return json(res,409,{error:'RECORD_CHANGED'});
          if(!r.cues.some(c=>c.id===input.cueId))return json(res,400,{error:'UNKNOWN_CUE'});
          r.humanReviews[input.cueId]={status:input.status,note:input.note,bbox:input.bbox,coordinateSpace:'analysis-normalized',reviewedAt:new Date().toISOString()};store.save(r);return json(res,200,r);
        }
      }
      const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(req.method==='GET'&&assets[path]){const [file,type]=assets[path];res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});res.end(readFileSync(resolve(root,'public',file)));return;}
      return json(res,404,{error:'NOT_FOUND'});
    }catch(e){const known=['IMAGE_TOO_LARGE','UNSUPPORTED_IMAGE','REQUEST_TOO_LARGE'].includes(e.message);return json(res,e.status||400,{error:known?e.message:'INVALID_REQUEST'});}
  });
  server.on('listening',()=>void pump());
  return {server,store,async close(){closing=true;await new Promise(resolve=>server.close(resolve));while(working)await new Promise(resolve=>setTimeout(resolve,50));store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // HOST is 0.0.0.0 only inside a container, whose port is published to the machine's 127.0.0.1.
  // Requests are still refused unless their Host header is 127.0.0.1 or localhost.
  const port=Number(process.env.PORT||3210),host=process.env.HOST||'127.0.0.1';const app=createApp();app.server.listen(port,host,()=>console.log(`Location Cue Lab: http://127.0.0.1:${port}`));
  app.server.on('error',()=>{console.error('Local server could not start. Check PORT and private-data access.');process.exitCode=1;});
}
