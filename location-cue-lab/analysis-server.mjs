// The analysis server the Spring backend calls (kkokkkok-backend NodeAnalysisClient), in place of
// the earlier runtime (KkokKkok-PoC src/app/api/inspections). Same three routes and headers, so the
// backend only needs NODE_ANALYSIS_BASE_URL pointed here. Local use only: nothing here is a
// deployment design.
//   POST   /api/inspections        multipart `photo`; X-Analysis-Api-Key, Idempotency-Key (UUID, becomes
//                                  the inspection id), X-Analysis-Consent: true          -> 202
//   GET    /api/inspections/{id}   X-Analysis-Api-Key                                    -> 200
//   DELETE /api/inspections/{id}   X-Analysis-Api-Key (a missing record is already deleted) -> 204
//   GET    /api/health             no key; says the process is up, nothing about models or keys
// One photo goes through: Detector clues -> rule sheet (unit and risk per clue, combinations) ->
// regions (PaddleOCR, Grounding DINO, text recheck, pointing) -> masks. Clues are not classified
// into the mined taxonomy: the rule sheet decides the risk, and that saves a model call.
// Records live under <data>/service/paper, apart from the research records under <data>/paper.
// The model is Claude through the Anthropic API (lib/paper-claude.mjs): ANTHROPIC_API_KEY,
// ANALYSIS_MODEL (default claude-fable-5-2), ANALYSIS_EFFORT (default medium).
// ANALYSIS_LLM=openai uses the research CLI's OpenAI path instead (OPENAI_API_KEY, OPENAI_MODEL).
//   ANALYSIS_API_KEY        required; the same value as the backend's NODE_ANALYSIS_API_KEY
//   ANALYSIS_PORT           default 3001 (the port the local start script gives the analysis server)
//   ANALYSIS_BIND_HOST      default 127.0.0.1
//   ANALYSIS_API_HOSTS      further Host headers to accept, comma-separated (loopback always is)
//   ANALYSIS_DATA_DIR       default <CUE_DATA_DIR or private-data>/service
//   ANALYSIS_INCLUDE_MASKS  'false' leaves the masks out of responses and skips Segment Anything
import http from 'node:http';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dataDir } from './lib/config.mjs';
import { prepareImage,realAdapters,sha } from './lib/adapters.mjs';
import { PaperStore } from './lib/paper-store.mjs';
import { paperLlm,paperStages,regionStage,ruleStage } from './lib/paper-llm.mjs';
import { extractImage,linkRunRegions,recheckRunText,relinkRunUnreadQuotes,pointRunClues,judgeRunRules } from './lib/paper-runner.mjs';
import { linkingTierFor } from './lib/paper-rules.mjs';
import { TIERED_POLICY,tierForLinking } from './lib/paper-risk-tiers.mjs';
import { maskRunRegions } from './lib/paper-masks.mjs';
import { toInspection } from './lib/paper-inspection.mjs';
import { claudeLlm,claudeStages } from './lib/paper-claude.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES=10*1024*1024,MAX_WAITING=20;
// Which API answers the model steps: {name,llm,stages,configured}. Claude unless ANALYSIS_LLM=openai.
// Claude credentials can also come from a profile the SDK finds by itself, so only the OpenAI path
// can be told to be unconfigured before a request is made.
export function modelProvider(env=process.env){
  const name=(env.ANALYSIS_LLM||'claude').trim().toLowerCase();
  if(name==='openai')return {name,llm:paperLlm,stages:()=>({paper:paperStages(env),rules:ruleStage(env),regions:regionStage(env)}),configured:()=>Boolean(env.OPENAI_API_KEY&&(env.OPENAI_MODEL||'').trim())};
  if(name!=='claude')throw new Error('INVALID_ANALYSIS_LLM');
  return {name,llm:claudeLlm({env}),stages:()=>claudeStages(env),configured:()=>true};
}

// One record through every step. Each step is skipped when the record already has its result, so a
// record interrupted by a restart continues where it stopped. run.service.state is what the
// inspection reports: failed when there are no clues or no judgement to show; a failed region or
// mask step leaves a completed inspection whose clues have no box (pipelineStages says so).
// How long the record waited for its turn and how long the analysis then took, start to finish.
const elapsed=service=>{const at=value=>Date.parse(value??''),seconds=(from,to)=>Number.isFinite(to-from)?{value:Math.round((to-from)/100)/10}:null;
  const waited=seconds(at(service?.receivedAt),at(service?.startedAt)),total=seconds(at(service?.startedAt),at(service?.finishedAt));
  return {...(waited?{waitedSeconds:waited.value}:{}),...(total?{totalSeconds:total.value}:{})};};
// cancelled: asked before every model and tool call and between steps. Once it says yes, nothing more
// is started and the record ends as failed with service:CANCELLED; what the steps had saved is kept.
const STOPPED=Symbol('cancelled');
export async function analyzeRun({store,id,stages,llm,tools,masks=true,onStep=()=>{},cancelled=()=>false}){
  let run=store.getRun(id);
  if(!run)return null;
  const finish=state=>{run.service={...run.service,state,finishedAt:new Date().toISOString()};return store.saveRun(run);};
  try{return await steps();}
  catch(error){
    if(error!==STOPPED&&!cancelled())throw error;
    run=store.getRun(id)??run;run.errors.push({stage:'service',code:'CANCELLED',at:new Date().toISOString()});
    return finish('failed');
  }
  async function steps(){
  run.service={...run.service,state:'processing',startedAt:run.service?.startedAt??new Date().toISOString()};store.saveRun(run);
  // Where a step's time goes: the model, OCR, the detector, the segmenter. Calls made at the same time
  // each count in full, so the parts can add up to more than the step itself.
  let spent={};
  const clock=(part,call)=>call&&(async(...args)=>{if(cancelled())throw STOPPED;const started=Date.now();try{return await call(...args);}finally{const now=spent[part]??={calls:0,ms:0};now.calls++;now.ms+=Date.now()-started;}});
  const tenths=ms=>Math.round(ms/100)/10;
  llm=clock('model',llm);tools={...tools,ocr:clock('ocr',tools.ocr),detect:clock('detect',tools.detect),segment:clock('segment',tools.segment)};
  const timed=async(name,step)=>{if(cancelled())throw STOPPED;spent={};const started=Date.now();const result=await step();if(cancelled())throw STOPPED;run=result??run;run.service={...run.service,seconds:{...run.service?.seconds,[name]:tenths(Date.now()-started)}};store.saveRun(run);onStep(name,run,Object.fromEntries(Object.entries(spent).map(([part,now])=>[part,{calls:now.calls,seconds:tenths(now.ms)}])));};
  if(run.status==='queued')await timed('extraction',()=>extractImage({store,prepared:{bytes:store.image(id),image:run.image},stages:stages.paper,llm,run,detectorPrompt:stages.detectorPrompt??null}));
  if(run.status!=='extracted'&&run.status!=='classified')return finish('failed');
  if(!run.clues.length)return finish('completed');
  if(!run.rules)await timed('rules',()=>judgeRunRules({store,run,stage:stages.rules,llm}));
  if(!run.rules)return finish('failed');
  const before=run.errors.length,ok=()=>run.errors.length===before;
  const ruleTier=linkingTierFor(run),tierOf=clue=>ruleTier(clue)??tierForLinking(clue);
  if(!run.regions)await timed('regions',()=>linkRunRegions({store,run,stage:stages.regions,llm,ocr:tools.ocr,detect:tools.detect,policy:TIERED_POLICY,tierOf}));
  // Quoted text the whole-photo OCR did not read: the model says where it is, that place is cut out,
  // enlarged and read once per clue (a reading is about 18 s; the four turns of the full recheck took
  // far longer for text that was then not read anyway). Not read: the clue gets the model's box, marked
  // unverified.
  if(run.regions&&ok())await timed('textRecheck',()=>recheckRunText({store,run,stage:stages.regions,llm,ocr:tools.ocr,triesPerClue:1}));
  // A quoted name that is written nowhere in the photo: the clue is looked for as an object after all.
  if(run.regions&&ok())await timed('unreadQuotes',()=>relinkRunUnreadQuotes({store,run,detect:tools.detect,policy:TIERED_POLICY,tierOf}));
  if(run.regions&&ok())await timed('pointing',()=>pointRunClues({store,run,stage:stages.regions,llm}));
  if(run.regions&&masks&&tools.segment)await timed('masks',()=>maskRunRegions({store,run,segment:tools.segment}));
  return finish('completed');
  }
}

export function createAnalysisApp({directory=resolve(process.env.ANALYSIS_DATA_DIR||resolve(dataDir,'service')),apiKey=(process.env.ANALYSIS_API_KEY||'').trim(),
  provider=modelProvider(),llm=provider.llm,tools=realAdapters,stages=provider.stages,prepare=prepareImage,masks=process.env.ANALYSIS_INCLUDE_MASKS!=='false',
  requireConfiguration=true,allowedHosts=(process.env.ANALYSIS_API_HOSTS||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean),log=()=>{}}={}){
  const store=new PaperStore(directory),waiting=[],deleted=new Set(),cancelled=new Set();
  // The record being analyzed stops: no further call is started, and a tool process that is running
  // (OCR, detector, segmenter) is ended. A model call already sent finishes and its answer is dropped.
  const stopRunning=id=>{cancelled.add(id);tools.stop?.();};
  let working=false,closing=false;
  const stateOf=run=>run.service?.state??'failed';
  const view=run=>toInspection(run,{status:stateOf(run),masks});
  async function pump(){
    if(working||closing)return;
    working=true;
    try{
      while(!closing&&waiting.length){
        const id=waiting.shift();
        try{
          const run=await analyzeRun({store,id,stages:stages(),llm,tools,masks,cancelled:()=>cancelled.has(id),onStep:(name,now,parts)=>log({inspectionId:id,step:name,seconds:now.service.seconds[name],...(Object.keys(parts).length?{parts}:{})})});
          if(run)log({inspectionId:id,state:run.service.state,clues:run.clues.length,errors:run.errors.map(entry=>`${entry.stage}:${entry.code}`),...elapsed(run.service)});
        }catch{
          // A step threw instead of recording its error. Only the fact is kept: no provider text.
          const run=store.getRun(id);
          if(run){run.service={...run.service,state:'failed'};run.errors.push({stage:'service',code:'ANALYSIS_FAILED',at:new Date().toISOString()});store.saveRun(run);}
          log({inspectionId:id,state:'failed',errors:['service:ANALYSIS_FAILED']});
        }
        // Deleted while it was running: the steps saved the record again.
        if(deleted.delete(id))store.deleteRun(id);
        cancelled.delete(id);
      }
    }finally{working=false;}
  }
  // Records a restart interrupted are taken up again, oldest first.
  for(const run of store.listRuns())if(['queued','processing'].includes(run.service?.state))waiting.push(run.id);

  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const refuse=(status,message)=>Object.assign(new Error(message),{status});
  async function body(req,limit){const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw refuse(413,'파일 크기가 제한을 초과했습니다.');chunks.push(part);}return Buffer.concat(chunks);}
  function authorize(req){
    if(!apiKey)throw refuse(503,'분석 서버 API 키가 설정되지 않았습니다.');
    const supplied=Buffer.from(String(req.headers['x-analysis-api-key']||'')),expected=Buffer.from(apiKey);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw refuse(401,'분석 서버 인증에 실패했습니다.');
  }
  async function accept(req){
    if(req.headers['x-analysis-consent']!=='true')throw refuse(400,'사진 보관 및 외부 분석 전송에 대한 동의가 필요합니다.');
    const key=String(req.headers['idempotency-key']||'').toLowerCase();
    if(!UUID.test(key))throw refuse(400,'요청 키 형식이 올바르지 않습니다.');
    const type=req.headers['content-type']||'';
    if(!type.startsWith('multipart/form-data'))throw refuse(415,'사진 업로드 요청 형식이 올바르지 않습니다.');
    const raw=await body(req,MAX_IMAGE_BYTES+128_000);
    let photo;
    try{photo=(await new Request('http://local/',{method:'POST',headers:{'content-type':type},body:raw}).formData()).get('photo');}
    catch{throw refuse(400,'사진 업로드 요청을 읽지 못했습니다.');}
    if(!photo||typeof photo==='string'||photo.size<1)throw refuse(400,'분석할 사진을 첨부해 주세요.');
    if(photo.size>MAX_IMAGE_BYTES)throw refuse(413,'사진은 10MB 이하여야 합니다.');
    const bytes=Buffer.from(await photo.arrayBuffer()),originalSha256=sha(bytes);
    const existing=store.getRun(key);
    if(existing){
      if(existing.service?.originalSha256!==originalSha256)throw refuse(409,'같은 업로드 요청에 다른 이미지를 사용할 수 없습니다.');
      return existing;
    }
    const settings=stages();
    if(requireConfiguration&&!provider.configured())throw refuse(503,'분석 모델이 설정되지 않았습니다.');
    if(waiting.length>=MAX_WAITING)throw refuse(429,'대기 중인 분석이 많습니다. 잠시 후 다시 요청해 주세요.');
    let prepared;
    try{prepared=await prepare(bytes);}
    catch(error){throw error?.message==='IMAGE_TOO_LARGE'?refuse(413,'사진은 10MB 이하여야 합니다.'):refuse(415,'JPEG, PNG 또는 WebP 사진만 분석할 수 있습니다.');}
    const run=store.createRun(prepared.image,prepared.bytes,settings.paper,key);
    run.service={state:'queued',originalSha256,receivedAt:new Date().toISOString()};
    store.saveRun(run);deleted.delete(key);waiting.push(key);void pump();
    return run;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      // Server-to-server only: a browser page (which sends Origin) is never a caller.
      const host=String(req.headers.host||'').toLowerCase();
      if((!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)&&!allowedHosts.includes(host))||req.headers.origin)throw refuse(403,'허용된 내부 분석 서버에서만 접근할 수 있습니다.');
      const path=new URL(req.url,'http://local').pathname;
      if(req.method==='GET'&&path==='/api/health')return json(res,200,{status:'ok'});
      const match=path.match(/^\/api\/inspections(?:\/([^/]+)(\/cancel)?)?$/);
      if(!match)throw refuse(404,'찾을 수 없습니다.');
      authorize(req);
      const id=match[1]?.toLowerCase();
      if(match[2]){
        // The caller gave up waiting. The record stays (failed, service:CANCELLED); one that had
        // already ended is left as it is.
        if(req.method!=='POST')throw refuse(405,'허용되지 않는 요청입니다.');
        if(!UUID.test(id))throw refuse(400,'분석 ID 형식이 올바르지 않습니다.');
        const run=deleted.has(id)?null:store.getRun(id);
        if(!run)throw refuse(404,'분석 작업을 찾을 수 없습니다.');
        const index=waiting.indexOf(id);
        if(index>=0){
          waiting.splice(index,1);
          run.service={...run.service,state:'failed',finishedAt:new Date().toISOString()};run.errors.push({stage:'service',code:'CANCELLED',at:new Date().toISOString()});
          store.saveRun(run);log({inspectionId:id,state:'failed',errors:['service:CANCELLED']});
        }else if(stateOf(run)==='processing')stopRunning(id);
        return json(res,200,view(store.getRun(id)));
      }
      if(!id){
        if(req.method!=='POST')throw refuse(405,'허용되지 않는 요청입니다.');
        return json(res,202,view(await accept(req)));
      }
      if(!UUID.test(id))throw refuse(400,'분석 ID 형식이 올바르지 않습니다.');
      if(req.method==='GET'){
        const run=deleted.has(id)?null:store.getRun(id);
        if(!run)throw refuse(404,'분석 작업을 찾을 수 없습니다.');
        return json(res,200,view(run));
      }
      if(req.method==='DELETE'){
        const index=waiting.indexOf(id);
        if(index>=0)waiting.splice(index,1);
        // A record being analyzed is deleted again when its steps end (they save it as they go).
        else if(store.getRun(id)?.service?.state==='processing'){deleted.add(id);stopRunning(id);}
        store.deleteRun(id);
        res.writeHead(204);res.end();return;
      }
      throw refuse(405,'허용되지 않는 요청입니다.');
    }catch(error){
      if(res.headersSent)return res.end();
      return json(res,error?.status||500,{error:error?.status?error.message:'분석 요청을 처리하지 못했습니다.'});
    }
  });
  server.on('listening',()=>void pump());
  return {server,store,pump,async close(){closing=true;await new Promise(done=>server.close(done));while(working)await new Promise(done=>setTimeout(done,50));}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.ANALYSIS_PORT||3001),host=process.env.ANALYSIS_BIND_HOST||'127.0.0.1';
  // Short codes and timings only: no photo, key or model text is logged.
  const app=createAnalysisApp({log:entry=>console.log(JSON.stringify({at:new Date().toISOString(),...entry}))});
  if(!process.env.ANALYSIS_API_KEY)console.error('ANALYSIS_API_KEY is not set: every inspection request will be refused (503).');
  const provider=modelProvider();
  if(provider.name==='claude'&&!process.env.ANTHROPIC_API_KEY&&!process.env.ANTHROPIC_AUTH_TOKEN)console.error('ANTHROPIC_API_KEY is not set: inspections will fail at the first model step unless the SDK finds another credential.');
  if(!provider.configured())console.error('OPENAI_API_KEY / OPENAI_MODEL are not set: new inspections will be refused (503).');
  app.server.on('error',()=>{console.error(`Analysis server could not start. Check port ${port}.`);process.exitCode=1;});
  app.server.listen(port,host,()=>console.log(`Analysis server: http://${host}:${port}  (model: ${provider.stages().paper.detector.model} via ${provider.name}; data: ${app.store.directory})`));
}
