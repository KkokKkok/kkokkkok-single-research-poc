// Serves the viewer written by `paper.mjs viewer` on this machine only (127.0.0.1), for browsers or
// tools that will not open file:// pages, and keeps what a reviewer says about each clue.
//   node scripts/viewer-server.mjs [--port 4173] [--dir <viewer dir>] [--reviews <file>]
// Reviews are kept OUTSIDE the viewer folder (default private-data/paper/reviews.json), so writing
// the viewer again does not lose them.
//   GET  /reviews.json  {version,reviews:{"<recordId>/<clueId>":{box,category,risk,at}}}
//   POST /reviews       {key,field,value}   value null removes the answer to that question
import { createServer } from 'node:http';
import { readFile,writeFile,rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve,extname,sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// No project modules are loaded, so this runs without the legacy package folder.
const args=process.argv.slice(2),flag=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:null;};
const root=resolve(flag('--dir')||fileURLToPath(new URL('../private-data/paper/viewer',import.meta.url))),port=Number(flag('--port')||4173);
const reviewsPath=resolve(flag('--reviews')||fileURLToPath(new URL('../private-data/paper/reviews.json',import.meta.url)));
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg'};
// The questions the page asks and the answers it may send. Anything else is refused.
export const REVIEW_FIELDS={box:['right','partial','wrong'],category:['right','wrong'],risk:['yes','no','unsure']};
const KEY=/^[0-9a-f-]{36}\/clue-\d{1,3}$/;

export async function readReviews(path=reviewsPath){
  if(!existsSync(path))return {version:1,reviews:{}};
  try{const stored=JSON.parse(await readFile(path,'utf8'));return {version:1,reviews:stored.reviews&&typeof stored.reviews==='object'?stored.reviews:{}};}
  catch{return {version:1,reviews:{}};}
}
// Returns the stored answer, or null when the change is not one the page can make.
export async function applyReview({key,field,value},path=reviewsPath){
  if(typeof key!=='string'||!KEY.test(key)||!Object.hasOwn(REVIEW_FIELDS,field)||!(value===null||REVIEW_FIELDS[field].includes(value)))return null;
  const stored=await readReviews(path),answer={...(stored.reviews[key]||{})};
  if(value===null)delete answer[field];else answer[field]=value;
  answer.at=new Date().toISOString();
  stored.reviews[key]=answer;stored.updatedAt=answer.at;
  const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(stored,null,1));await rename(temporary,path);
  return answer;
}
const json=(response,status,body)=>response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(JSON.stringify(body));

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // One write at a time: answers arrive in quick succession and each rewrites the whole file.
  let queue=Promise.resolve();
  createServer(async(request,response)=>{
    try{
      const path=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      if(request.method==='GET'&&path==='/reviews.json'){json(response,200,await readReviews());return;}
      if(request.method==='POST'&&path==='/reviews'){
        // Only this page may write: a request another site made the browser send carries its own Origin.
        const origin=request.headers.origin;
        if(origin&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)){json(response,403,{error:'origin'});return;}
        if(!String(request.headers['content-type']||'').startsWith('application/json')){json(response,415,{error:'type'});return;}
        let body='';
        for await(const chunk of request){body+=chunk;if(body.length>2000){json(response,413,{error:'size'});return;}}
        let change;try{change=JSON.parse(body);}catch{json(response,400,{error:'json'});return;}
        const task=queue.then(()=>applyReview(change));queue=task.catch(()=>{});
        const answer=await task;
        json(response,answer?200:400,answer?{ok:true,answer}:{error:'review'});return;
      }
      const file=resolve(root,`.${path==='/'?'/index.html':path}`);
      // Nothing outside the viewer folder, and only the three kinds of file the viewer consists of.
      if(request.method!=='GET'||!(file===root||file.startsWith(root+sep))||!TYPES[extname(file)]){response.writeHead(404).end();return;}
      response.writeHead(200,{'Content-Type':TYPES[extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}).end(await readFile(file));
    }catch{response.writeHead(404).end();}
  }).listen(port,'127.0.0.1',()=>console.log(`viewer: http://127.0.0.1:${port}/`));
}
