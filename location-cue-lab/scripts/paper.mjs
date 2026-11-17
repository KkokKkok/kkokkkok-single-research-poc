// Paper-method CLI: Detector clue extraction, ClueMiner taxonomy mining, clue classification.
//   node scripts/paper.mjs extract <image> [<image> ...] [--no-classify]
//   node scripts/paper.mjs taxonomy figure25        (registers the paper's 31-type table as a taxonomy)
//   node scripts/paper.mjs taxonomy group <taxonomyId>   (copy of a mined taxonomy with the reviewer's groups)
//   node scripts/paper.mjs mine [--max-rounds 5] [--seed 42] [--resume <mining-run-name>] [--from <taxonomyId>] [--input <selection>]
//   node scripts/paper.mjs classify (--all | <runId> ...) [--taxonomy <taxonomyId>]
//   node scripts/paper.mjs list
//   node scripts/paper.mjs settings
//   node scripts/paper.mjs pending
//   node scripts/paper.mjs regions (--all | <runId> ...) [--force] [--all-clues]   (default: risk tiers decide which clues are searched)
//   node scripts/paper.mjs recheck (--all | <runId> ...) [--force]   (quoted text OCR did not link: read again where the model says it is, else the model's box; `regions` runs this too)
//   node scripts/paper.mjs masks (--all | <runId> ...) [--force]   (Segment Anything: the shape inside each detector box; after `regions`)
//   node scripts/paper.mjs rules (--all | <runId> ...) [--force]   (the owner's rule sheet: unit and risk per clue, and combinations; before `regions` if boxes should follow it)
//   node scripts/paper.mjs evidence (--all | <runId> ...) [--force]   (clues as fixed-form evidence records with a key that is the same in another photo; after `regions`)
//   node scripts/paper.mjs evidence --place <name> <runId> <runId> ... [--check]   (photos of one place, in order: each evidence gets placeClueId, and seenBefore when an earlier photo showed it; --check: medium and high clues without text are compared in the two photos by a model)
//   node scripts/paper.mjs evidence --group <runId> <runId> ...   (photos of one place: their evidence with each clue counted once)
//   node scripts/paper.mjs preview [--out <file.html>] [--images <dir>]
//   node scripts/paper.mjs viewer [--out <dir>] [--revealed] [--judged]   (interactive page: boxes on and off per clue; --revealed: only photos whose place came out; --judged: only photos judged by `rules`)
//   node scripts/paper.mjs locate (--all | <runId> ...) [--top3] [--force]     (evaluation only)
//   node scripts/paper.mjs score (<original image> ... | --pilot <pilot dir>) [--radius 500] [--geocoder naver|google] [--force]   (evaluation only)
//   node scripts/paper.mjs places (<original image> ... | --pilot <pilot dir>) [--radius 500] [--force] [--combine]   (evaluation only; --combine also tries texts in pairs and with the guessed district)
//   node scripts/paper.mjs probe (--all | <runId> ...) [--force] [--export [--out file]]   (counts map-search results per quoted text; needs no true position)
//   node scripts/paper.mjs reviews [<reviews.json>]   (counts what a person answered in the viewer, by clue label)
// Add --handoff <stand-in-label> to extract/mine/classify to run without an API key: each model
// request is written to private-data/paper/handoff/<id>/ and the command stops until a stand-in
// has written response.txt there. Run the same command again to continue.
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { dataDir,sharp } from '../lib/config.mjs';
import { prepareImage,realAdapters } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { paperLlm,paperStages,regionStage,ruleStage,evidenceStage,locatorStage } from '../lib/paper-llm.mjs';
import { handoffLlm,handoffBrief,pendingHandoffs,HANDOFF_PENDING } from '../lib/paper-handoff.mjs';
import { extractAndClassify,classifyRun,mineTaxonomy,linkRunRegions,recheckRunText,relinkRunUnreadQuotes,pointRunClues,judgeRunRules,normalizeRunEvidence,assignRunClues,locateRun,scoreRun,searchPlacesRun } from '../lib/paper-runner.mjs';
import { linkingTierFor } from '../lib/paper-rules.mjs';
import { groupEvidence } from '../lib/paper-evidence.mjs';
import { maskRunRegions } from '../lib/paper-masks.mjs';
import { searchCombinationsRun } from '../lib/paper-combo.mjs';
import { probePlacesRun,probeLedger } from '../lib/paper-probe.mjs';
import { reviewSummary } from '../lib/paper-risk.mjs';
import { GEOCODERS,DEFAULT_RADIUS_M,pilotTruths,naverPlaceSearch } from '../lib/paper-score.mjs';
import { parseGps } from '../lib/location-experiment.mjs';
import { renderOverlay,buildPreviewHtml } from '../lib/paper-preview.mjs';
import { viewerData,VIEWER_HTML } from '../lib/paper-viewer.mjs';
import { TIERED_POLICY,tierForLinking,isCombinationBasis } from '../lib/paper-risk-tiers.mjs';
import { FIGURE25_SOURCE,FIGURE25_KOREAN,figure25Categories } from '../lib/paper-taxonomy-figure25.mjs';
import { MINED_GROUP_OF,MINED_KOREAN } from '../lib/paper-taxonomy-mined-labels.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={},positional=[];
for(let i=0;i<rest.length;i++){
  const arg=rest[i];
  if(['--max-rounds','--seed','--resume','--from','--taxonomy','--handoff','--out','--images','--radius','--geocoder','--pilot','--input','--place'].includes(arg))flags[arg.slice(2)]=rest[++i];
  else if(arg.startsWith('--'))flags[arg.slice(2)]=true;
  else positional.push(arg);
}
const usage=()=>{console.error(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(1,26).map(line=>line.replace(/^\/\/ ?/,'')).join('\n'));process.exit(1);};
const store=new PaperStore(dataDir);
const handoff=typeof flags.handoff==='string'&&flags.handoff.trim()?flags.handoff.trim():null;
if('handoff' in flags&&!handoff)usage();
const stages=paperStages(process.env,{handoffModel:handoff});
const llm=handoff?handoffLlm(store.handoffDirectory):paperLlm;
const requireModel=stage=>{
  if(handoff)return;
  if(!process.env.OPENAI_API_KEY||!stage.model){console.error('Configure OPENAI_API_KEY and OPENAI_MODEL (or a PAPER_*_MODEL override), or use --handoff <stand-in-label>.');process.exit(1);}
};
const showClues=run=>{for(const clue of run.clues)console.log(`  ${clue.id}  [${clue.taxonomy?`${clue.taxonomy.number}. ${clue.taxonomy.name}`:'unclassified'}]  ${clue.category}: ${clue.detail}`);};
// Says which model a stage is about to use and whether that is the paper's setting.
const showStage=(name,stage)=>console.log(JSON.stringify({stage:name,model:stage.model,transport:stage.transport,reasoningEffort:stage.reasoningEffort??'not sent',matchesPaper:stage.matchesPaper,paperModel:stage.paperModel}));
const showPending=pending=>{console.log(JSON.stringify({status:'pending',stage:pending.stage??null,handoffId:pending.id,directory:pending.directory}));console.log(handoffBrief(pending.directory));};
const MODEL_HINT='The model could not be called with this key. Set OPENAI_MODEL, or PAPER_DETECTOR_MODEL / PAPER_CLUEMINER_MODEL / PAPER_CLASSIFIER_MODEL, to a model this key can use.';
const hintOnModelErrors=errors=>{if(errors.some(e=>e.providerCode==='model_not_found'||e.httpStatus===404))console.log(MODEL_HINT);};

if(command==='settings'){
  for(const [name,stage] of Object.entries(stages))console.log(JSON.stringify({stage:name,...stage}));
}else if(command==='pending'){
  for(const request of pendingHandoffs(store.handoffDirectory))showPending(request);
}else if(command==='extract'){
  if(!positional.length)usage();
  requireModel(stages.detector);
  const taxonomy=flags['no-classify']?null:store.latestTaxonomy();
  showStage('detector',stages.detector);if(taxonomy)showStage('classifier',stages.classifier);
  for(const path of positional){
    const prepared=await prepareImage(readFileSync(resolve(path)));
    // A hand-off record that was waiting for an answer (Detector or classifier) continues in place.
    const run=await extractAndClassify({store,prepared,stages,llm,taxonomy,resume:Boolean(handoff)});
    console.log(JSON.stringify({runId:run.id,status:run.status,clues:run.clues.length,taxonomyId:run.classification?.taxonomyId??null,errors:run.errors,record:store.runPath(run.id)}));
    showClues(run);hintOnModelErrors(run.errors);
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(run.status==='failed')process.exitCode=2;
  }
  if(!taxonomy&&!flags['no-classify'])console.log('No taxonomy yet: clues are unclassified. Run "taxonomy figure25" or "mine", then "classify --all".');
}else if(command==='taxonomy'){
  // Registers a published category table as a taxonomy, so clues can be classified before there are
  // enough photos to mine one. No model call. Registering the same table again returns the stored one.
  if(positional[0]==='group'){
    // taxonomy group <taxonomyId>: a copy of a mined taxonomy whose ungrouped categories carry the
    // reviewer's groups (paper-taxonomy-mined-labels.mjs). Names, definitions and numbers are kept, so
    // the classifier prompt is the same; only tallies and the preview use the group. No model call.
    const base=store.getTaxonomy(positional[1]||'');
    if(!base){console.error('Taxonomy not found. See "list" for taxonomy ids.');process.exit(1);}
    const categories=base.categories.map(category=>category.group||!MINED_GROUP_OF[category.name]?category:{...category,group:MINED_GROUP_OF[category.name]});
    const grouped=store.listTaxonomies().find(known=>JSON.stringify(known.categories)===JSON.stringify(categories))
      ??store.saveTaxonomy({categories,model:base.model,stage:base.stage,source:{...base.source,groupedFrom:base.id,groupsBy:'reviewer (paper-taxonomy-mined-labels.mjs)'}});
    console.log(JSON.stringify({taxonomyId:grouped.id,categories:grouped.categories.length,groupedFrom:base.id,ungrouped:grouped.categories.filter(category=>!category.group).map(category=>category.name)}));
    process.exit(0);
  }
  if(positional[0]!=='figure25')usage();
  const categories=figure25Categories();
  const taxonomy=store.listTaxonomies().find(known=>known.source?.kind==='paper_figure'&&JSON.stringify(known.categories)===JSON.stringify(categories))
    ??store.saveTaxonomy({categories,model:null,stage:null,source:{kind:'paper_figure',...FIGURE25_SOURCE}});
  console.log(JSON.stringify({taxonomyId:taxonomy.id,categories:taxonomy.categories.length,source:taxonomy.source.paper}));
  for(const category of taxonomy.categories)console.log(`  ${category.number}. ${category.name}: ${category.definition}`);
}else if(command==='mine'){
  requireModel(stages.clueMiner);
  // With the hand-off every step stops the command, so an unfinished run is picked up automatically.
  const resume=flags.resume||(handoff?store.unfinishedMining()?.name:null)||null;
  // --from <taxonomyId>: start from that taxonomy's categories instead of an empty list (new runs only).
  const seedTaxonomy=typeof flags.from==='string'&&!resume?store.getTaxonomy(flags.from):null;
  if(typeof flags.from==='string'&&!resume&&!seedTaxonomy){console.error('Taxonomy not found. See "list" for taxonomy ids.');process.exit(1);}
  // --input <name>: mine the clue lists of the address predictions chosen in
  // private-data/paper/clueminer-input/<name>.json (paper-batch.mjs select), as the paper does.
  // Without it the stored Detector clues of every extracted record are mined.
  let runIds=null,inputSelection=null;
  if(typeof flags.input==='string'&&!resume){
    const path=resolve(store.directory,'clueminer-input',`${flags.input}.json`);
    if(!existsSync(path)){console.error('Input selection not found. Make one with: node scripts/paper-batch.mjs select --name <name> ...');process.exit(1);}
    const selection=JSON.parse(readFileSync(path,'utf8'));
    runIds=selection.entries.filter(entry=>entry.included).map(entry=>entry.runId);inputSelection=selection.name;
    console.log(JSON.stringify({input:selection.name,entries:runIds.length,rule:selection.rule}));
  }
  if(!resume)showStage('clueMiner',stages.clueMiner);
  try{
    const {taxonomy,rounds,converged,directory}=await mineTaxonomy({store,stage:stages.clueMiner,llm,maxRounds:Number(flags['max-rounds']||5),seed:Number(flags.seed||42),resume,seedTaxonomy,runIds,inputSelection,
      onProgress:p=>console.log(JSON.stringify(p))});
    console.log(JSON.stringify({taxonomyId:taxonomy.id,categories:taxonomy.categories.length,model:taxonomy.model,rounds,converged,logs:directory}));
    for(const category of taxonomy.categories)console.log(`  ${category.number}. ${category.name}: ${category.definition}`);
    if(!converged)console.log('Not converged within the round limit: categories may still change. Re-run with --resume and a higher --max-rounds, or add more images.');
  }catch(error){
    if(error?.message===HANDOFF_PENDING){showPending({stage:'clueMiner',...error.handoff});process.exitCode=3;}
    else{
      // Provider messages can quote part of a key, so only short codes are printed.
      const failure={stage:'clueMiner',code:/^[A-Z][A-Z0-9_]*$/.test(error?.message||'')?error.message:'STAGE_FAILED',httpStatus:Number.isInteger(error?.status)?error.status:null,providerCode:typeof error?.code==='string'&&/^[a-z0-9_]{1,64}$/.test(error.code)?error.code:null};
      console.log(JSON.stringify({status:'failed',error:failure}));hintOnModelErrors([failure]);
      console.log('Steps already completed are saved; continue with --resume <mining-run-name> once the cause is fixed.');
      process.exitCode=2;
    }
  }
}else if(command==='classify'){
  requireModel(stages.classifier);
  const taxonomy=flags.taxonomy?store.getTaxonomy(flags.taxonomy):store.latestTaxonomy();
  if(!taxonomy){console.error('No taxonomy found. Run "taxonomy figure25" or "mine" first.');process.exit(1);}
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  showStage('classifier',stages.classifier);
  for(const source of runs){
    if(!['extracted','classified'].includes(source.status))continue;
    const run=await classifyRun({store,run:source,taxonomy,stage:stages.classifier,llm});
    const errors=run.errors.filter(e=>e.stage==='classifier');
    console.log(JSON.stringify({runId:run.id,status:run.status,taxonomyId:run.classification?.taxonomyId??null,errors:errors.length}));
    showClues(run);hintOnModelErrors(errors.slice(-1));
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(run.status!=='classified')process.exitCode=2;
  }
}else if(command==='masks'){
  // Not a paper step: the shape of what each detector box holds, from Segment Anything (paper-masks.mjs).
  // No model is asked anything: only records already linked by `regions` are touched.
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  for(const source of runs){
    if(!source.regions||(source.masks&&!flags.force))continue;
    const before=source.errors.length,started=Date.now();
    const run=await maskRunRegions({store,run:source,segment:realAdapters.segment,force:Boolean(flags.force)});
    console.log(JSON.stringify({runId:run.id,status:run.errors.length>before?'failed':'masked',boxes:run.masks?.boxes??null,regions:run.masks?.regions??null,model:run.masks?.model??null,seconds:Math.round((Date.now()-started)/100)/10,errors:run.errors.slice(before)}));
  }
}else if(command==='rules'){
  // Not a paper step: the owner's rule sheet (paper-rules.mjs). A text-only model call per record.
  const stage=ruleStage(process.env,{handoffModel:handoff});
  requireModel(stage);
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  showStage('rules',stage);
  for(const source of runs){
    if(!['extracted','classified'].includes(source.status)||!source.clues.length||(source.rules&&!flags.force))continue;
    const before=source.errors.length;
    const run=await judgeRunRules({store,run:source,stage,llm,force:Boolean(flags.force)});
    const failed=run.errors.length>before,risks=run.clues.map(clue=>clue.rule?.risk);
    console.log(JSON.stringify({runId:run.id,status:run.pending?'pending':failed?'failed':'judged',clues:run.clues.length,high:risks.filter(risk=>risk==='high').length,medium:risks.filter(risk=>risk==='medium').length,low:risks.filter(risk=>risk==='low').length,
      combinations:run.rules?.combinations.map(combo=>({type:combo.type,clueIds:combo.clueIds,risk:combo.risk}))??null,rejectedCombinations:run.rules?.rejectedCombinations.length??null,errors:run.errors.slice(before)}));
    hintOnModelErrors(run.errors.slice(before));
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(failed)process.exitCode=2;
  }
}else if(command==='evidence'){
  // Not a paper step: clues rewritten as evidence records with a photo-independent key (paper-evidence.mjs).
  if(flags.place){
    // The photos of one place, in the order given: each record's evidence gets the place's clue ids,
    // and `seenBefore` on what an earlier photo already showed.
    const runs=positional.map(id=>store.getRun(id));
    if(typeof flags.place!=='string'||!runs.length||runs.some(run=>!run?.evidence))usage();
    // --check: clues that narrow the place down are matched only when a model, shown both photos, says they are the same object.
    const checkStage=flags.check?evidenceStage(process.env,{handoffModel:handoff}):null;
    if(checkStage){requireModel(checkStage);showStage('placeCheck',checkStage);}
    for(const source of runs){
      const before=source.errors.length;
      const run=await assignRunClues({store,run:source,place:flags.place,...(flags.check?{stage:checkStage,llm}:{})});
      if(run.pending){console.log(JSON.stringify({runId:run.id,status:'pending',requests:run.pending.all.length}));for(const request of run.pending.all)showPending({stage:'placeCheck',...request});process.exitCode=3;break;}
      if(run.errors.length>before){console.log(JSON.stringify({runId:run.id,status:'failed',errors:run.errors.slice(before)}));process.exitCode=2;break;}
      const verdicts=run.placeChecks?.checks.map(check=>check.verdict)??[];
      console.log(JSON.stringify({runId:run.id,place:run.place,evidence:run.evidence.length,new:run.evidence.filter(item=>!item.seenBefore).length,seenBefore:run.evidence.filter(item=>item.seenBefore).length,...(flags.check?{checked:verdicts.length,same:verdicts.filter(verdict=>verdict==='same').length,different:verdicts.filter(verdict=>verdict==='different').length,unsure:verdicts.filter(verdict=>verdict==='unsure').length}:{})}));
    }
    console.log(JSON.stringify({place:flags.place,clues:store.getPlace(flags.place)?.clues.length??0}));
  }else if(flags.group){
    const runs=positional.map(id=>store.getRun(id));
    if(runs.length<2||runs.some(run=>!run?.evidence))usage();
    console.log(JSON.stringify(groupEvidence(runs.map(run=>({runId:run.id,evidence:run.evidence}))),null,2));
  }else{
    const stage=evidenceStage(process.env,{handoffModel:handoff});
    requireModel(stage);
    const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
    if(!runs.length||runs.some(run=>!run))usage();
    showStage('evidence',stage);
    for(const source of runs){
      if(!['extracted','classified'].includes(source.status)||!source.clues.length||(source.evidence&&!flags.force))continue;
      const before=source.errors.length;
      const run=await normalizeRunEvidence({store,run:source,stage,llm,force:Boolean(flags.force)});
      const failed=run.errors.length>before;
      console.log(JSON.stringify({runId:run.id,status:run.pending?'pending':failed?'failed':'normalized',clues:run.clues.length,evidence:failed||run.pending?null:run.evidence.length,skipped:failed||run.pending?null:run.normalization.skipped.length,errors:run.errors.slice(before)}));
      hintOnModelErrors(run.errors.slice(before));
      if(run.pending){showPending(run.pending);process.exitCode=3;}
      else if(failed)process.exitCode=2;
    }
  }
}else if(command==='regions'){
  // Not a paper step: finds where each clue is, with PaddleOCR and Grounding DINO (see paper-regions.mjs).
  const stage=regionStage(process.env,{handoffModel:handoff});
  requireModel(stage);
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  showStage('regionTargets',stage);
  for(const source of runs){
    // A record linked but parked at the text recheck or at the pointing step (hand-off answer awaited) is continued from there.
    const parkedStage=source.regions&&!flags.force?source.pending?.stage:null,parkedAtRecheck=['textHints','cluePoint'].includes(parkedStage);
    if(!['extracted','classified'].includes(source.status)||(source.regions&&!flags.force&&!parkedAtRecheck))continue;
    const before=source.errors.length,ruleTier=linkingTierFor(source);
    // The parked step is about to be repeated: without this its marker would make the steps below skip themselves.
    if(parkedAtRecheck)delete source.pending;
    let run=parkedAtRecheck?source:await linkRunRegions({store,run:source,stage,llm,ocr:realAdapters.ocr,detect:realAdapters.detect,...(flags['all-clues']?{}:{policy:TIERED_POLICY,tierOf:clue=>ruleTier(clue)??tierForLinking(clue)})});
    // Quoted text that OCR did not link is read again where the model says it is (paper-text-recheck.mjs).
    if(parkedStage!=='cluePoint'&&!run.pending&&run.errors.length===before)run=await recheckRunText({store,run,stage,llm,ocr:realAdapters.ocr,force:true});
    // A quoted name written nowhere in the photo: that clue is looked for by the detector as an object (paper-regions.mjs relinkUnreadQuotes).
    if(!run.pending&&run.errors.length===before)run=await relinkRunUnreadQuotes({store,run,detect:realAdapters.detect,...(flags['all-clues']?{}:{policy:TIERED_POLICY,tierOf:clue=>ruleTier(clue)??tierForLinking(clue)})});
    // A clue used in an inference that still has no region gets the box the model points at (paper-point.mjs).
    if(!run.pending&&run.errors.length===before)run=await pointRunClues({store,run,stage,llm,force:true});
    const failed=run.errors.length>before;
    console.log(JSON.stringify({runId:run.id,status:run.pending?'pending':failed?'failed':'linked',clues:run.clues.length,pointed:run.regions?.pointing?{asked:run.regions.pointing.clues,pointed:run.regions.pointing.pointed}:null,located:run.clues.filter(clue=>clue.regions?.length).length,
      textRegions:run.clues.reduce((n,clue)=>n+(clue.regions||[]).filter(r=>r.kind==='text').length,0),objectRegions:run.clues.reduce((n,clue)=>n+(clue.regions||[]).filter(r=>r.kind==='object').length,0),
      textRecheck:run.regions?.textRecheck?{clues:run.regions.textRecheck.clues,verified:run.regions.textRecheck.verified,standIn:run.regions.textRecheck.standIn,noHint:run.regions.textRecheck.noHint}:null,ocrLines:run.regions?.ocr?.lineCount??null,detectorQueries:run.regions?.detection?.queryCount??null,errors:run.errors.slice(before)}));
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(failed)process.exitCode=2;
  }
}else if(command==='recheck'){
  // For records already linked: only the text recheck, without reading the whole photo again.
  const stage=regionStage(process.env,{handoffModel:handoff});
  requireModel(stage);
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  showStage('textHints',stage);
  for(const source of runs){
    if(!source.regions||(source.regions.textRecheck&&!flags.force))continue;
    const before=source.errors.length;
    const run=await recheckRunText({store,run:source,stage,llm,ocr:realAdapters.ocr,force:Boolean(flags.force)});
    const failed=run.errors.length>before,summary=run.regions.textRecheck;
    console.log(JSON.stringify({runId:run.id,status:run.pending?'pending':failed?'failed':'rechecked',clues:summary?.clues??null,verified:summary?.verified??null,standIn:summary?.standIn??null,noHint:summary?.noHint??null,ocrCalls:summary?.ocrCalls??null,errors:run.errors.slice(before)}));
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(failed)process.exitCode=2;
  }
}else if(command==='locate'){
  // Evaluation only (the paper's CoT experiment): asks the model where each photo was taken.
  const stage=locatorStage(process.env,{handoffModel:handoff});
  requireModel(stage);
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if(!runs.length||runs.some(run=>!run))usage();
  const topN=flags.top3?3:1;
  console.log('Evaluation only: this asks a model where each photo was taken. Use it on photos whose owner agreed, never in the product path.');
  showStage('locator',stage);
  for(const source of runs){
    if(!['registered','extracted','classified'].includes(source.status))continue;
    const before=source.errors.length;
    const run=await locateRun({store,run:source,stage,llm,topN,force:Boolean(flags.force)});
    const prediction=(run.predictions||[]).find(p=>p.model===stage.model&&p.transport===stage.transport&&p.topN===topN);
    const failed=run.errors.length>before;
    console.log(JSON.stringify({runId:run.id,status:run.pending?'pending':failed?'failed':prediction?.status??'skipped',topN,clues:prediction?.clueList?.length??null,addresses:prediction?.addressList??null,errors:run.errors.slice(before)}));
    hintOnModelErrors(run.errors.slice(before));
    if(run.pending){showPending(run.pending);process.exitCode=3;}
    else if(failed)process.exitCode=2;
  }
}else if(command==='score'){
  // Evaluation only: geocodes each predicted address and measures how far it is from the position
  // in the original photo's EXIF. The photo is matched to its record by the analysis-image hash.
  const pilot=typeof flags.pilot==='string'?resolve(flags.pilot):null;
  if(!positional.length&&!pilot)usage();
  const name=typeof flags.geocoder==='string'?flags.geocoder:'naver',geocoder=GEOCODERS[name];
  const radiusM=flags.radius===undefined?DEFAULT_RADIUS_M:Number(flags.radius);
  if(!geocoder||!(radiusM>0))usage();
  console.log('Evaluation only: this compares predicted addresses with the position stored in the original photos. The position itself is not printed or saved.');
  console.log(JSON.stringify({geocoder:name,matchesPaperGeocoder:geocoder.matchesPaper,radiusM,truth:pilot?'pilot ground truth':'original photo EXIF'}));
  let blocked=null;
  const report=run=>{for(const prediction of run.predictions)console.log(JSON.stringify({runId:run.id,model:prediction.model,topN:prediction.topN,prediction:prediction.status,score:prediction.score?.status??null,
    geocode:prediction.score?.candidates.map(candidate=>candidate.geocodeStatus)??null,distanceM:prediction.score?.distanceM===null||prediction.score?.distanceM===undefined?null:Math.round(prediction.score.distanceM),withinRadius:prediction.score?.withinRadius??null}));};
  if(pilot){
    // --pilot <dir>: positions the location pilot already read from the originals' EXIF, matched to
    // records by image hash. For when the original files are not at hand.
    const truths=await pilotTruths({pilotDirectory:pilot,imagesDirectory:resolve(dataDir,'images'),prepare:prepareImage});
    const runs=store.listRuns().filter(run=>run.predictions?.length);
    console.log(JSON.stringify({recordsWithPredictions:runs.length,withGroundTruth:runs.filter(run=>truths.has(run.image.sha256)).length}));
    for(const source of runs){
      if(blocked)break;
      const truth=truths.get(source.image.sha256);
      if(!truth){console.log(JSON.stringify({runId:source.id,status:'no_ground_truth'}));continue;}
      const result=await scoreRun({store,run:source,truth,geocoder:name,geocode:geocoder.geocode,radiusM,matchesPaperGeocoder:geocoder.matchesPaper,truthSource:'location_pilot_exif',force:Boolean(flags.force)});
      report(result.run);
      if(result.blocked)blocked=result.blocked;
    }
  }
  for(const path of positional){
    if(blocked)break;
    const bytes=readFileSync(resolve(path));
    const truth=parseGps((await sharp(bytes).metadata()).exif);
    if(truth.status!=='found'){console.log(JSON.stringify({file:path,status:`gps_${truth.status}`}));process.exitCode=2;continue;}
    const {image}=await prepareImage(bytes);
    const runs=store.listRuns().filter(run=>run.image.sha256===image.sha256&&run.predictions?.length);
    if(!runs.length){console.log(JSON.stringify({file:path,status:'no_prediction'}));continue;}
    for(const source of runs){
      const result=await scoreRun({store,run:source,truth,geocoder:name,geocode:geocoder.geocode,radiusM,matchesPaperGeocoder:geocoder.matchesPaper,force:Boolean(flags.force)});
      for(const prediction of result.run.predictions)console.log(JSON.stringify({runId:result.run.id,model:prediction.model,topN:prediction.topN,prediction:prediction.status,score:prediction.score?.status??null,
        geocode:prediction.score?.candidates.map(candidate=>candidate.geocodeStatus)??null,distanceM:prediction.score?.distanceM===null||prediction.score?.distanceM===undefined?null:Math.round(prediction.score.distanceM),withinRadius:prediction.score?.withinRadius??null}));
      if(result.blocked){blocked=result.blocked;break;}
    }
  }
  if(blocked){
    console.log(JSON.stringify({status:'geocoder_unavailable',reason:blocked}));
    console.log(name==='naver'?'Set NAVER_MAPS_CLIENT_ID and NAVER_MAPS_CLIENT_SECRET (in .env), and select Geocoding on the Maps application in the NAVER Cloud console.':'Set GOOGLE_MAPS_API_KEY and enable the Geocoding API.');
    process.exitCode=2;
  }
}else if(command==='places'){
  // Evaluation only, and not a paper step: types every text the Detector quoted from a photo into
  // NAVER's place search, as a person would type a shop name into a map, and measures how far the
  // results are from the true position. Shows which visible text gives the place away by itself.
  const pilot=typeof flags.pilot==='string'?resolve(flags.pilot):null;
  if(!positional.length&&!pilot)usage();
  const radiusM=flags.radius===undefined?DEFAULT_RADIUS_M:Number(flags.radius);
  if(!(radiusM>0))usage();
  console.log('Evaluation only: this sends the texts quoted from each photo to NAVER place search and compares the results with the position stored in the original photos. The position is not sent, printed or saved.');
  const truths=pilot?await pilotTruths({pilotDirectory:pilot,imagesDirectory:resolve(dataDir,'images'),prepare:prepareImage}):new Map();
  for(const path of positional){
    const bytes=readFileSync(resolve(path)),gps=parseGps((await sharp(bytes).metadata()).exif);
    if(gps.status!=='found'){console.log(JSON.stringify({file:path,status:`gps_${gps.status}`}));process.exitCode=2;continue;}
    truths.set((await prepareImage(bytes)).image.sha256,gps);
  }
  let blocked=null;
  for(const source of store.listRuns()){
    if(blocked)break;
    const truth=truths.get(source.image.sha256);
    if(!truth||!['extracted','classified'].includes(source.status))continue;
    const result=await searchPlacesRun({store,run:source,truth,search:naverPlaceSearch,radiusM,truthSource:pilot?'location_pilot_exif':'original_exif',force:Boolean(flags.force)});
    if(result.blocked){blocked=result.blocked;break;}
    let record=result.run;
    // --combine: also tries the texts that revealed nothing alone, in pairs and with the district
    // the address guess pointed to (paper-combo.mjs). The guess stays inside this evaluation.
    if(flags.combine&&record.placeSearches){
      const combined=await searchCombinationsRun({store,run:record,truth,search:naverPlaceSearch,geocode:GEOCODERS.naver.geocode,tierOf:tierForLinking,basisOf:isCombinationBasis,radiusM,force:Boolean(flags.force)});
      if(combined.blocked){blocked=combined.blocked;break;}
      record=combined.run;
    }
    console.log(JSON.stringify({runId:record.id,queries:record.placeSearches.length,revealing:record.placeSearches.filter(search=>search.topWithinRadius).length,
      ...(flags.combine?{combinations:record.comboSearches?.length??0,revealingCombinations:(record.comboSearches||[]).filter(search=>search.withinRadius).length}:{})}));
    for(const search of result.run.placeSearches)console.log(`  ${search.topWithinRadius?'HIT ':search.anyWithinRadius?'near':'    '} ${JSON.stringify(search.query)}  results ${search.results.length}/${search.total??'?'}  first ${search.topDistanceM===null?'-':Math.round(search.topDistanceM)+'m'}  closest ${search.bestDistanceM===null?'-':Math.round(search.bestDistanceM)+'m'}`);
  }
  if(blocked){
    console.log(JSON.stringify({status:'place_search_unavailable',reason:blocked}));
    console.log('Set NAVER_APIHUB_CLIENT_ID and NAVER_APIHUB_CLIENT_SECRET (in .env). They come from a NAVER API HUB application with the local (지역) search API selected; a Maps application key does not work for this API.');
    process.exitCode=2;
  }
}else if(command==='probe'){
  // Not a paper step. Counts what the map search returns for each text quoted from a photo, without
  // any true position: so it also runs for photos that carry none (paper-probe.mjs). Only the texts go out.
  // --export [--out file]: writes the stored counts of every probed record as JSON lines (paper-probe.mjs
  // probeLedger), for the cumulative analysis. Alone, without --all or ids, it searches nothing.
  const runs=flags.all?store.listRuns():positional.map(id=>store.getRun(id));
  if((!runs.length&&!flags.export)||runs.some(run=>!run))usage();
  if(runs.length)console.log('This sends the texts quoted from each photo to NAVER place search and stores how many places come back, in all and in the assumed area. No position is sent or stored.');
  let blocked=null,records=0,texts=0,none=0;
  for(const source of runs){
    const result=await probePlacesRun({store,run:source,search:naverPlaceSearch,force:Boolean(flags.force)});
    if(result.blocked){blocked=result.blocked;break;}
    if(!result.run.placeProbes)continue;
    records++;texts+=result.run.placeProbes.length;none+=result.run.placeProbes.filter(probe=>probe.inAreaCount===0).length;
  }
  if(runs.length)console.log(JSON.stringify({records,texts,withoutResultInArea:none}));
  if(flags.export){
    const out=resolve(typeof flags.out==='string'?flags.out:resolve(store.directory,'probe-counts.jsonl')),rows=probeLedger(store.listRuns());
    writeFileSync(out,rows.map(row=>JSON.stringify(row)).join('\n')+(rows.length?'\n':''));
    console.log(JSON.stringify({exported:out,rows:rows.length,records:new Set(rows.map(row=>row.recordId)).size}));
  }
  if(blocked){console.log(JSON.stringify({status:'place_search_unavailable',reason:blocked}));process.exitCode=2;}
}else if(command==='preview'){
  // Local page only: photos and clues can reveal a location, so it is written under private-data.
  const out=resolve(flags.out||resolve(store.directory,'preview','index.html'));
  const translations=resolve(dirname(out),'ko.json');
  const korean=existsSync(translations)?JSON.parse(readFileSync(translations,'utf8')):{};
  const entries=[];
  for(const run of store.listRuns()){
    if(!['extracted','classified'].includes(run.status)||!run.clues.length)continue;
    entries.push({run,overlay:await renderOverlay(store.image(run.id),run.clues),korean:korean[run.id]});
  }
  mkdirSync(dirname(out),{recursive:true});
  writeFileSync(out,buildPreviewHtml(entries,{taxonomyLabels:{...FIGURE25_KOREAN,...MINED_KOREAN}}));
  // --images <dir> also writes each annotated photo as photo-<n>.jpg, for use in a written report.
  if(typeof flags.images==='string'){
    const directory=resolve(flags.images);mkdirSync(directory,{recursive:true});
    entries.forEach((entry,index)=>writeFileSync(resolve(directory,`photo-${index+1}.jpg`),entry.overlay));
  }
  console.log(JSON.stringify({photos:entries.length,file:out,koreanSummaries:Object.keys(korean).length,images:typeof flags.images==='string'?resolve(flags.images):null}));
}else if(command==='viewer'){
  // Local page only, like the preview: an interactive viewer that draws each clue's boxes itself, so
  // they can be switched on and off. Writes index.html, data.js and images/ under private-data.
  const out=resolve(flags.out||resolve(store.directory,'viewer'));
  const koreanPath=resolve(store.directory,'preview','ko.json'),photosPath=resolve(store.directory,'batches','all-photos.json');
  const korean=existsSync(koreanPath)?JSON.parse(readFileSync(koreanPath,'utf8')):{};
  // batches/all-photos.json, when present, names each record by its folder and number in the folder.
  const named=new Map((existsSync(photosPath)?JSON.parse(readFileSync(photosPath,'utf8')).photos:[]).map(photo=>[photo.runId,photo]));
  const runs=store.listRuns().filter(run=>['extracted','classified'].includes(run.status)&&run.clues.length);
  const order=new Map([...named.keys()].map((id,index)=>[id,index]));
  runs.sort((a,b)=>(order.get(a.id)??1e9)-(order.get(b.id)??1e9));
  mkdirSync(resolve(out,'images'),{recursive:true});
  // review-picks.json, when present: photos a person is asked to look at first, each with the question
  // to answer. {"picks":[{"photo":"<folder> <number>","ask":"..."}]}
  const picksPath=resolve(store.directory,'review-picks.json');
  const picks=new Map((existsSync(picksPath)?JSON.parse(readFileSync(picksPath,'utf8')).picks:[]).map((pick,index)=>[pick.photo,{order:index+1,ask:pick.ask}]));
  const entries=[];
  for(const [index,run] of runs.entries()){
    const photo=named.get(run.id);
    const title=photo?`${photo.folder} ${photo.index}`:`사진 ${index+1}`;
    entries.push({run,korean:korean[run.id],folder:photo?.folder??null,title,pick:picks.get(title)??null});
  }
  const data=viewerData(entries,{labels:{...FIGURE25_KOREAN,...MINED_KOREAN}});
  // --revealed: only the photos whose place came out, by a map search of a clue (확인된 위험) or by the
  // address guess (사진 경고). Give --out as well, or the full viewer is replaced by this selection.
  if(flags.revealed)data.photos=data.photos.filter(photo=>photo.measured.confirmed||photo.warning);
  // --judged: only the photos the rule sheet has been applied to (`rules`). Give --out as well.
  if(flags.judged)data.photos=data.photos.filter(photo=>photo.risk.judged);
  for(const photo of data.photos)writeFileSync(resolve(out,'images',`${photo.id}.jpg`),await sharp(store.image(photo.id)).resize({width:1100,height:1100,fit:'inside',withoutEnlargement:true}).jpeg({quality:84}).toBuffer());
  writeFileSync(resolve(out,'data.js'),`window.VIEWER_DATA=${JSON.stringify(data)};\n`);
  writeFileSync(resolve(out,'index.html'),VIEWER_HTML);
  console.log(JSON.stringify({photos:data.photos.length,withBoxes:data.photos.filter(photo=>photo.boxes).length,picks:data.photos.filter(photo=>photo.pick).length,file:resolve(out,'index.html')}));
}else if(command==='reviews'){
  // What a person answered in the viewer (private-data/paper/reviews.json, or a file the page
  // exported), counted against the label each clue has now.
  const path=resolve(positional[0]||resolve(store.directory,'reviews.json'));
  if(!existsSync(path)){console.log(JSON.stringify({reviews:0,file:path,note:'no reviews yet'}));process.exit(0);}
  const stored=JSON.parse(readFileSync(path,'utf8')).reviews||{};
  const summary=reviewSummary(store.listRuns(),stored);
  console.log(JSON.stringify({file:path,reviewedClues:summary.reviewed,unknownKeys:summary.unknown}));
  for(const [label,counts] of Object.entries(summary.byLabel))console.log(JSON.stringify({label,...counts}));
}else if(command==='list'){
  for(const run of store.listRuns())console.log(JSON.stringify({runId:run.id,createdAt:run.createdAt,status:run.status,clues:run.clues.length,detectorModel:run.stages?.detector?.model??null,transport:run.stages?.detector?.transport??null,taxonomyId:run.classification?.taxonomyId??null}));
  for(const taxonomy of store.listTaxonomies())console.log(JSON.stringify({taxonomyId:taxonomy.id,categories:taxonomy.categories.length,kind:taxonomy.source?.kind??'clueminer',model:taxonomy.model,seedTaxonomyId:taxonomy.source?.seedTaxonomyId??null,converged:taxonomy.source?.converged??null}));
}else usage();
