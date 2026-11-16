// Runs the paper-method steps against the PaperStore. Model and image adapters are injected so
// tests can run without the network.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharp } from './config.mjs';
import { extractClues,classifyClues,mineCategories,predictLocation,entryText,shuffled,numberTaxonomy,sortedMemory } from './paper-pipeline.mjs';
import { linkRegions,quotedStrings } from './paper-regions.mjs';
import { scoreAddresses,scorePlaceSearch } from './paper-score.mjs';

// Only short codes are stored; provider error text (which can quote part of a key) never reaches a record.
const providerCode=error=>typeof error?.code==='string'&&/^[a-z0-9_]{1,64}$/.test(error.code)?error.code:null;
const errorEntry=(stage,error)=>({stage,code:/^[A-Z][A-Z0-9_]*$/.test(error?.message||'')?error.message:'STAGE_FAILED',httpStatus:Number.isInteger(error?.status)?error.status:null,providerCode:providerCode(error),at:new Date().toISOString()});
// A hand-off answer is read again on every re-run; it is recorded once (its response id is stable).
const recorder=(store,run)=>call=>{
  if(!run.modelCalls.some(seen=>seen.stage===call.stage&&seen.attempt===call.attempt&&seen.responseId&&seen.responseId===call.responseId))run.modelCalls.push(call);
  store.saveRun(run);
};
// With the file hand-off a request can be waiting for its answer. That is not a failure: the
// record is parked as pending and the same call is repeated once the answer file exists.
const isPending=error=>error?.message==='HANDOFF_PENDING';

// prepared: {bytes,image} from prepareImage(), i.e. the normalized, metadata-free JPEG.
// stages: the per-stage settings from paperStages(); they are stored on the record as used.
// run: a pending record of the same image to continue, instead of creating a new one.
export async function extractImage({store,prepared,stages,llm,run=null}){
  run??=store.createRun(prepared.image,prepared.bytes,stages);
  if(run.status==='registered')run.stages=stages;
  delete run.pending;
  try{
    const result=await extractClues({bytes:prepared.bytes,model:stages.detector.model,reasoningEffort:stages.detector.reasoningEffort,llm,onCall:recorder(store,run)});
    run.detector={answer:result.answer,detectorJson:result.detectorJson,candidateCategories:result.candidateCategories,attempts:result.attempts};
    run.clues=result.clues;run.status='extracted';
  }catch(error){
    if(isPending(error)){run.status='pending';run.pending={stage:'detector',...error.handoff};}
    else{run.status='failed';run.errors.push(errorEntry('detector',error));}
  }
  return store.saveRun(run);
}

export async function classifyRun({store,run,taxonomy,stage,llm}){
  if(!['extracted','classified'].includes(run.status))return run;
  // The classifier setting may differ from the one in force when the image was extracted.
  run.stages={...run.stages,classifier:stage};
  delete run.pending;
  try{
    const result=await classifyClues({clues:run.clues,categories:taxonomy.categories,model:stage.model,reasoningEffort:stage.reasoningEffort,llm,onCall:recorder(store,run)});
    run.clues=result.clues;run.status='classified';
    run.classification={taxonomyId:taxonomy.id,model:stage.model,reasoningEffort:stage.reasoningEffort,answer:result.answer,attempts:result.attempts,classifiedAt:new Date().toISOString()};
  }catch(error){
    // Waiting for a hand-off answer leaves the record as it was, apart from the pending marker.
    if(isPending(error))run.pending={stage:'classifier',...error.handoff};
    else{
      run.clues=run.clues.map(clue=>({...clue,taxonomy:null}));run.status='extracted';
      run.classification=null;run.errors.push(errorEntry('classifier',error));
    }
  }
  return store.saveRun(run);
}

// One image through extraction and, when a taxonomy is given, classification. With resume (the
// file hand-off), a record parked at either step is continued: without this, re-running the command
// while the classifier answer is awaited would extract the same image into a second record.
export async function extractAndClassify({store,prepared,stages,llm,taxonomy=null,resume=false}){
  // A photo registered for evaluation only (no Detector call yet) is extracted into its own record.
  const parked=(resume?store.findPendingRun(prepared.image.sha256):null)??store.findRegisteredRun(prepared.image.sha256);
  let run=parked&&!['pending','registered'].includes(parked.status)?parked:await extractImage({store,prepared,stages,llm,run:parked});
  if(run.status==='extracted'&&taxonomy)run=await classifyRun({store,run,taxonomy,stage:stages.classifier,llm});
  return run;
}

// PaddleOCR's detector fails on this machine for a 2304x3072 image ("Unknown exception" from the
// inference engine) while 1125x2000 works, so the tools get a copy whose longer side is at most
// 2000 px. Regions are stored in normalized coordinates, so they apply to the full image unchanged.
export const MAX_TOOL_SIDE=2000;
export async function toolCopy(bytes,maxSide=MAX_TOOL_SIDE){
  const {width,height}=await sharp(bytes).metadata();
  if(Math.max(width,height)<=maxSide)return {bytes,width,height,resized:false};
  const {data,info}=await sharp(bytes).resize(maxSide,maxSide,{fit:'inside'}).jpeg({quality:95}).toBuffer({resolveWithObject:true});
  return {bytes:data,width:info.width,height:info.height,resized:true};
}
// Adds image regions to an extracted run (paper-regions.mjs; not a paper step). ocr and detect are
// the existing PaddleOCR and Grounding DINO adapters. Re-running replaces the earlier regions.
export async function linkRunRegions({store,run,stage,llm,ocr,detect,prepare=toolCopy,policy=null,tierOf=()=>null}){
  if(!['extracted','classified'].includes(run.status)||!run.clues.length)return run;
  delete run.pending;
  try{
    const clues=run.clues.map(({textTargets,objectTargets,regions,localization,risk,...clue})=>clue);
    const tool=await prepare(store.image(run.id));
    const result=await linkRegions({bytes:tool.bytes,clues,model:stage.model,reasoningEffort:stage.reasoningEffort,llm,ocr,detect,policy,tierOf,onCall:recorder(store,run)});
    run.clues=result.clues;run.regions={...result.summary,stage,toolImage:{width:tool.width,height:tool.height,resized:tool.resized,maxSide:MAX_TOOL_SIDE}};
  }catch(error){
    if(isPending(error))run.pending={stage:'regionTargets',...error.handoff};
    else run.errors.push(errorEntry('regions',error));
  }
  return store.saveRun(run);
}

// EVALUATION ONLY. Asks a model where the photo was taken, with the paper's CoT prompt, and stores
// the answer on the record as a prediction. The image is the stored analysis copy, which carries no
// metadata, so the model cannot read a position from the file. Nothing here knows the true position:
// scoring against ground truth is a separate step. One prediction is kept per model and Top-N.
export async function locateRun({store,run,stage,llm,topN=1,force=false}){
  // 'registered': the photo is stored but the Detector has not run. The CoT prompt needs only the image.
  if(!['registered','extracted','classified'].includes(run.status))return run;
  run.predictions??=[];
  const same=prediction=>prediction.model===stage.model&&prediction.transport===stage.transport&&prediction.topN===topN;
  if(run.predictions.some(same)&&!force)return run;
  delete run.pending;
  try{
    const result=await predictLocation({bytes:store.image(run.id),model:stage.model,reasoningEffort:stage.reasoningEffort,llm,topN,onCall:recorder(store,run)});
    run.predictions=[...run.predictions.filter(prediction=>!same(prediction)),{createdAt:new Date().toISOString(),model:stage.model,reasoningEffort:stage.reasoningEffort,transport:stage.transport,matchesPaper:stage.matchesPaper,topN,
      status:result.addressList?.length?'answered':'no_address',answer:result.answer,clueListRaw:result.clueListRaw,addressListRaw:result.addressListRaw,clueList:result.clueList,addressList:result.addressList,score:null}];
  }catch(error){
    if(isPending(error))run.pending={stage:'locator',...error.handoff};
    else run.errors.push(errorEntry('locator',error));
  }
  return store.saveRun(run);
}

// EVALUATION ONLY. Scores the stored address predictions of one record against the true position
// (paper-score.mjs). truth comes from the original photo's EXIF and is not written to the record.
// A prediction already scored is left alone unless force is set. Returns {run,blocked}: blocked is
// the geocoder status that stopped the scoring (missing key, rejected key, quota), or null.
export async function scoreRun({store,run,truth,geocoder,geocode,distance,radiusM,matchesPaperGeocoder=false,truthSource,force=false}){
  for(const prediction of run.predictions||[]){
    if(prediction.status!=='answered'||(prediction.score&&!force))continue;
    const score=await scoreAddresses({addresses:prediction.addressList,truth,geocoder,geocode,distance,radiusM,matchesPaperGeocoder,truthSource});
    if(score.blocked)return {run,blocked:score.status};
    prediction.score=score;store.saveRun(run);
  }
  return {run,blocked:null};
}

// The texts the Detector quoted from the photo, each once, with the clues they came from and
// whether OCR also read them there. These are what a person could type into a map search.
export function placeQueries(run,limit=20){
  const queries=new Map();
  for(const clue of run.clues||[]){
    for(const text of clue.textTargets??quotedStrings(clue.detail)){
      const entry=queries.get(text)??{query:text,clueIds:[],seenByOcr:false};
      entry.clueIds.push(clue.id);
      if((clue.regions||[]).some(region=>region.kind==='text'&&region.quoted===text))entry.seenByOcr=true;
      queries.set(text,entry);
    }
  }
  return [...queries.values()].slice(0,limit);
}
// Shorter things to type when a quoted text finds nothing (added 2026-11-16). A wall that reads
// "서울시립 서서울미술관 미디어 작가전 / Seo-Seoul Museum of Art Solo Exhibition ..." names the place, but
// the map search knows the museum, not the sentence: typed whole it found nothing, the clue was
// lowered, and the address guess read the same wall and found the place. A person would type the
// name alone. Without a model to pick the name out, the candidates are mechanical:
//   the parts between separators ( / | · : ; brackets, line breaks), in order
//   then, for each part of three or more words, the part with words dropped from the end,
//   down to two words (a single leading word such as "서울시립" names no place)
// At most `limit` candidates, none equal to the text itself.
export const MAX_SHORTER_QUERIES=6;
export function shorterQueries(text,limit=MAX_SHORTER_QUERIES){
  const clean=value=>value.replace(/^[\s.…,'"‘’“”\-–—]+|[\s.…,'"‘’“”\-–—]+$/g,'');
  const parts=String(text).split(/\s*[\/|·•:;()\[\]\n]+\s*/).map(clean).filter(part=>part.length>=2);
  const candidates=parts.length>1?[...parts]:[];
  for(const part of parts.length?parts:[clean(String(text))]){
    const words=part.split(/\s+/);
    for(let keep=words.length-1;keep>=2;keep--)candidates.push(words.slice(0,keep).join(' '));
  }
  return [...new Set(candidates)].filter(candidate=>candidate!==text).slice(0,limit);
}
// Runs `attempt(query)` for the text and, while it finds nothing, for its shorter forms. Returns the
// first result that found something, marked with the query that found it (`searchedAs`) and how many
// shorter forms were typed (`shorterTried`); or the original empty result. A blocked service is
// returned at once.
export async function withShorterQueries(text,attempt){
  const first=await attempt(text);
  if(first.blocked||first.status!=='no_result')return first;
  let tried=0;
  for(const candidate of shorterQueries(text)){
    tried++;
    const next=await attempt(candidate);
    if(next.blocked)return next;
    if(next.status!=='no_result')return {...next,query:text,searchedAs:candidate,shorterTried:tried};
  }
  return {...first,shorterTried:tried};
}
// EVALUATION ONLY. Types each quoted text into the place search and measures how far the results
// are from the true position (paper-score.mjs scorePlaceSearch). Not a paper step: the paper's
// models answered without tools. Replaces earlier searches of the record. Returns {run,blocked}.
export async function searchPlacesRun({store,run,truth,search,distance,radiusM,truthSource,force=false}){
  if(!['extracted','classified'].includes(run.status))return {run,blocked:null};
  if(run.placeSearches?.length&&!force)return {run,blocked:null};
  const searches=[];
  for(const entry of placeQueries(run)){
    const score=await withShorterQueries(entry.query,query=>scorePlaceSearch({query,truth,search,distance,radiusM}));
    if(score.blocked)return {run,blocked:score.status};
    searches.push({...score,clueIds:entry.clueIds,seenByOcr:entry.seenByOcr,truthSource:truthSource??'original_exif',truthAccuracyM:truth.accuracyM??null});
  }
  run.placeSearches=searches;
  return {run:store.saveRun(run),blocked:null};
}

// The newest successful run per image, so re-extracting a photo does not weigh it twice.
export function miningCorpus(store){
  const latest=new Map();
  for(const run of store.listRuns())if(['extracted','classified'].includes(run.status)&&run.clues.length)latest.set(run.image.sha256,run);
  return [...latest.values()];
}

// Builds a taxonomy with ClueMiner. Two sources of clues:
//   runIds given  -> the paper's source: the clue_list each of those records' address prediction
//                    (CoT prompt) said it used. Which predictions count as correct is decided before
//                    this is called (scripts/paper-batch.mjs select); the paper took those whose
//                    metropolitan area was right. clueSource: 'cot_prediction_clue_list'.
//   runIds absent -> the stored Detector clues of every extracted record, the earlier departure kept
//                    for when no address guess or ground truth exists. clueSource: 'geominer_detector'.
// A resumed run keeps the model and reasoning setting it started with, whatever `stage` says now.
// seedTaxonomy (not in the paper, whose memory starts empty): an existing taxonomy to grow from. Its
// categories are the starting memory, so the analyzer adds to, merges or rewrites them instead of
// starting over. Categories that keep their name keep their group.
export const predictionClueList=run=>(run?.predictions||[]).filter(prediction=>prediction.status==='answered'&&prediction.clueList?.length).at(-1)?.clueList??null;
export async function mineTaxonomy({store,stage,llm,maxRounds=5,seed=42,resume=null,seedTaxonomy=null,runIds=null,inputSelection=null,onProgress=()=>{}}){
  const name=resume||`mine-${new Date().toISOString().replace(/[-:.]/g,'').slice(0,15)}`;
  const directory=store.miningDirectory(name);
  let checkpoint=resume?store.loadCheckpoint(directory):null;
  if(resume&&!checkpoint)throw new Error('CHECKPOINT_NOT_FOUND');
  if(checkpoint?.finished&&checkpoint.converged)throw new Error('MINING_ALREADY_CONVERGED');
  if(!checkpoint){
    const fromPredictions=Array.isArray(runIds);
    const corpus=fromPredictions?[...new Set(runIds)].map(id=>{const run=store.getRun(id);if(!predictionClueList(run))throw new Error('INPUT_RUN_WITHOUT_CLUE_LIST');return run;}):miningCorpus(store);
    const runs=shuffled(corpus,seed);
    if(!runs.length)throw new Error(fromPredictions?'NO_INPUT_RUNS':'NO_EXTRACTED_RUNS');
    const startMemory=Object.fromEntries((seedTaxonomy?.categories||[]).map(category=>[category.name,category.definition]));
    const seedGroups=Object.fromEntries((seedTaxonomy?.categories||[]).filter(category=>category.group).map(category=>[category.name,category.group]));
    checkpoint={name,createdAt:new Date().toISOString(),model:stage.model,stage,seed,seedTaxonomyId:seedTaxonomy?.id??null,seedGroups,clueSource:fromPredictions?'cot_prediction_clue_list':'geominer_detector',inputSelection,entryKeys:runs.map(run=>run.id),state:{round:1,index:0,memory:startMemory,roundStartMemory:startMemory},finished:false};
    store.saveCheckpoint(directory,checkpoint);
  }
  const entries=checkpoint.entryKeys.map(key=>{const run=store.getRun(key);if(!run)throw new Error('CHECKPOINT_RUN_MISSING');return {key,text:checkpoint.clueSource==='cot_prediction_clue_list'?predictionClueList(run).map(clue=>`- ${clue}`).join('\n'):entryText(run.clues)};});
  const result=await mineCategories({entries,state:checkpoint.state,maxRounds,model:checkpoint.model,reasoningEffort:checkpoint.stage?.reasoningEffort??null,llm,onStep:step=>{
    if(!step.roundFinished){
      store.saveMiningStep(directory,`round${step.round}-${String(step.entryIndex).padStart(4,'0')}-${step.entry.key}`,{
        metadata:{round:step.round,entry_index:step.entryIndex,entry_key:step.entry.key,timestamp:Date.now()/1000,model:checkpoint.model,entry_skipped:step.skipped,skip_reason:step.reason,token_usage:step.raw?.usage??null,response_id:step.raw?.responseId??null},
        input:{system_prompt:'',user_prompt:step.prompt,single_entry:[step.entry.text],previous_memory:sortedMemory(step.previousMemory)},
        output:{raw_response:step.response,parsed_categories:sortedMemory(step.memory),category_count:Object.keys(step.memory).length,memory_source:step.skipped?'previous':'updated'},
      });
      onProgress({round:step.round,entryIndex:step.entryIndex,total:entries.length,categories:Object.keys(step.memory).length,skipped:step.skipped,reason:step.reason});
    }
    checkpoint.state=step.state;store.saveCheckpoint(directory,checkpoint);
  }});
  writeFileSync(resolve(directory,'final_categories.json'),JSON.stringify(result.memory,null,2));
  if(!Object.keys(result.memory).length)throw new Error('TAXONOMY_EMPTY');
  const groups=checkpoint.seedGroups||{};
  const categories=numberTaxonomy(result.memory).map(category=>groups[category.name]?{...category,group:groups[category.name]}:category);
  const taxonomy=store.saveTaxonomy({categories,model:checkpoint.model,stage:checkpoint.stage??null,source:{kind:'clueminer',miningRun:name,runIds:checkpoint.entryKeys,seed:checkpoint.seed,seedTaxonomyId:checkpoint.seedTaxonomyId??null,rounds:result.rounds,converged:result.converged,clueSource:checkpoint.clueSource??'geominer_detector',inputSelection:checkpoint.inputSelection??null}});
  // An unconverged run can be resumed later with a higher round limit.
  checkpoint.finished=true;checkpoint.converged=result.converged;checkpoint.taxonomyId=taxonomy.id;store.saveCheckpoint(directory,checkpoint);
  return {taxonomy,rounds:result.rounds,converged:result.converged,directory};
}
