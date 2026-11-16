// File store for the paper-method pipeline, kept apart from cues.sqlite so the existing app and
// its records are untouched. Layout under <dataDir>/paper:
//   runs/<id>.json        one image's extraction (and classification) record
//   images/<id>.jpg       the normalized analysis image
//   taxonomy/<id>.json    numbered category sets built by ClueMiner
//   clueminer/<runName>/  per-step logs and the resume checkpoint of one mining run
import { mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { PAPER_PROMPT_VERSION,PROMPT_SOURCES } from './paper-prompts.mjs';

const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
function writeJson(path,value){const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify(value,null,2));renameSync(temporary,path);}
const safeName=name=>String(name).replace(/[<>:"/\\|?*\s]/g,'_');

export class PaperStore {
  constructor(dataDirectory){
    this.directory=resolve(dataDirectory,'paper');
    for(const part of ['runs','images','taxonomy','clueminer'])mkdirSync(resolve(this.directory,part),{recursive:true});
  }
  // stages: {detector,clueMiner,classifier} settings from paperStages(), each with matchesPaper.
  // v2 replaced the v1 `models` map of plain model names with these per-stage settings.
  createRun(image,bytes,stages){
    const now=new Date().toISOString();
    const run={schemaVersion:'paper-clues-v2',id:randomUUID(),createdAt:now,updatedAt:now,status:'queued',promptVersion:PAPER_PROMPT_VERSION,promptSources:PROMPT_SOURCES,stages,image,detector:null,clues:[],classification:null,modelCalls:[],errors:[]};
    writeFileSync(resolve(this.directory,'images',`${run.id}.jpg`),bytes);
    return this.saveRun(run);
  }
  // A record that holds only the analysis image: no Detector call yet. `locate` (evaluation) can run
  // on it, and a later `extract` of the same photo fills this record instead of making a second one.
  registerRun(image,bytes,stages){const run=this.createRun(image,bytes,stages);run.status='registered';return this.saveRun(run);}
  findRegisteredRun(imageSha256){return this.listRuns().filter(run=>run.image.sha256===imageSha256&&run.status==='registered').at(-1)||null;}
  saveRun(run){run.updatedAt=new Date().toISOString();writeJson(resolve(this.directory,'runs',`${run.id}.json`),run);return run;}
  runPath(id){return resolve(this.directory,'runs',`${safeName(id)}.json`);}
  getRun(id){const path=this.runPath(id);return existsSync(path)?readJson(path):null;}
  listRuns(){return readdirSync(resolve(this.directory,'runs')).filter(name=>name.endsWith('.json')).map(name=>readJson(resolve(this.directory,'runs',name))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
  image(id){return readFileSync(resolve(this.directory,'images',`${safeName(id)}.jpg`));}
  // File hand-off: where requests wait for an answer, and the record parked for a given image.
  get handoffDirectory(){return resolve(this.directory,'handoff');}
  // Parked means waiting for a hand-off answer at the Detector (status pending) or, once extracted,
  // at the classifier. Other steps that park a record (regions, locate) are resumed by their own command.
  findPendingRun(imageSha256){return this.listRuns().filter(run=>run.image.sha256===imageSha256&&(run.status==='pending'||(run.status==='extracted'&&run.pending?.stage==='classifier'))).at(-1)||null;}

  // categories: [{number,name,definition}]. The id is derived from the content, so the same
  // category set always gets the same id and a classification can name the set it used.
  saveTaxonomy({categories,model,stage=null,source}){
    const digest=createHash('sha256').update(JSON.stringify(categories)).digest('hex').slice(0,12);
    const createdAt=new Date().toISOString();
    const taxonomy={schemaVersion:'paper-taxonomy-v1',id:`${createdAt.replace(/[-:.]/g,'').slice(0,15)}-${digest}`,createdAt,promptVersion:PAPER_PROMPT_VERSION,model,stage,source,categories};
    writeJson(resolve(this.directory,'taxonomy',`${taxonomy.id}.json`),taxonomy);
    return taxonomy;
  }
  listTaxonomies(){return readdirSync(resolve(this.directory,'taxonomy')).filter(name=>name.endsWith('.json')).sort().map(name=>readJson(resolve(this.directory,'taxonomy',name)));}
  getTaxonomy(id){const path=resolve(this.directory,'taxonomy',`${safeName(id)}.json`);return existsSync(path)?readJson(path):null;}
  latestTaxonomy(){return this.listTaxonomies().at(-1)||null;}

  miningDirectory(name){const directory=resolve(this.directory,'clueminer',safeName(name));mkdirSync(resolve(directory,'steps'),{recursive:true});return directory;}
  saveMiningStep(directory,name,value){writeJson(resolve(directory,'steps',`${safeName(name)}.json`),value);}
  saveCheckpoint(directory,value){writeJson(resolve(directory,'checkpoint.json'),value);}
  loadCheckpoint(directory){const path=resolve(directory,'checkpoint.json');return existsSync(path)?readJson(path):null;}
  // The newest mining run that has not produced its taxonomy yet (interrupted or waiting on a hand-off).
  unfinishedMining(){
    const root=resolve(this.directory,'clueminer');
    return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>this.loadCheckpoint(resolve(root,entry.name)))
      .filter(checkpoint=>checkpoint&&!checkpoint.finished).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1)||null;
  }
}
