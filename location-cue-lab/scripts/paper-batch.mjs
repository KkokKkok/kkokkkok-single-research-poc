// EVALUATION ONLY. Batches of new photos for the paper path, kept in folders named after the place
// ("집_당산", "회사_충무로"). Not a paper step: the paper scores every photo against its own position.
//   node scripts/paper-batch.mjs sample <photo root> --name round1 [--per-folder 10] [--seed 42] [--folders a,b] [--exclude round1]
//       Draws photos per folder with a fixed seed, stores each as a registered record (no Detector
//       call) and writes private-data/paper/batches/<name>.json. Prints the record ids for `locate`.
//   node scripts/paper-batch.mjs score --name round1 [--radius 500] [--area-radius 1000] [--force]
//       Photo with a position in EXIF: scored as `paper.mjs score` does (radius 500 m).
//       Every photo: also scored against its folder's reference point, radius 1000 m (folderScore):
//         - the medoid of the positions of that folder's photos that do have one, or
//         - when no photo in the folder has one, the first NAVER place-search result for the place
//           name in the folder name plus "역" (the station of that name).
//       For a photo without a position the folder score is the only judgement there is.
//   node scripts/paper-batch.mjs select --name input1 --batches round1,round2 [--cap 학교=5] [--group-address 학교=Heukseok-ro] [--seed 42]
//       Chooses the address predictions whose clue lists go into ClueMiner (paper.mjs mine --input input1)
//       and writes private-data/paper/clueminer-input/<name>.json. A prediction is chosen when
//         - the photo has a position and the guess is within 500 m of it, or within 1,000 m and in
//           the folder's district, or
//         - the photo has no position and the guess is within 1,000 m of the folder's reference point
//           and in the folder's district.
//       Records outside the batches count when their stored score is within its radius (500 m).
//       --group-address puts such a record in a folder's group when its address matches the pattern;
//       --cap keeps at most that many of a group, drawn with the seed.
//       The paper's rule is wider (metropolitan area right) and has no cap.
// No coordinate is printed or written: records and the manifest hold distances only.
import { readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { dataDir,sharp } from '../lib/config.mjs';
import { prepareImage } from '../lib/adapters.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { paperStages } from '../lib/paper-llm.mjs';
import { shuffled } from '../lib/paper-pipeline.mjs';
import { scoreRun } from '../lib/paper-runner.mjs';
import { GEOCODERS,DEFAULT_RADIUS_M,geodesicDistanceM,naverPlaceSearch,isBlocking } from '../lib/paper-score.mjs';
import { parseGps } from '../lib/location-experiment.mjs';

const [command,...rest]=process.argv.slice(2);
const flags={},positional=[];
for(let i=0;i<rest.length;i++){
  const arg=rest[i];
  if(['--name','--per-folder','--seed','--radius','--area-radius','--folders','--exclude','--batches','--cap','--group-address'].includes(arg))flags[arg.slice(2)]=rest[++i];
  else if(arg.startsWith('--'))flags[arg.slice(2)]=true;
  else positional.push(arg);
}
const usage=()=>{console.error(readFileSync(new URL(import.meta.url),'utf8').split('\n').slice(2,24).map(line=>line.replace(/^\/\/ ?/,'')).join('\n'));process.exit(1);};
if(typeof flags.name!=='string'||!/^[\w-]+$/.test(flags.name))usage();
const store=new PaperStore(dataDir);
const batchDirectory=resolve(store.directory,'batches');mkdirSync(batchDirectory,{recursive:true});
const manifestPath=resolve(batchDirectory,`${flags.name}.json`);
const IMAGE=/\.(jpe?g|png|webp)$/i;
const gpsOf=async path=>parseGps((await sharp(readFileSync(path)).metadata()).exif);
// Fast approximate distance, used only to pick the medoid; reported distances use the geodesic engine.
const haversineM=(a,b)=>{const rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;return 2*6371008.8*Math.asin(Math.sqrt(h));};
// The medoid is the photo position with the smallest total distance to the others: a real position
// from the folder, and not pulled away by one photo taken elsewhere.
function medoid(points){
  let best=null;
  for(const candidate of points){const total=points.reduce((sum,other)=>sum+haversineM(candidate,other),0);if(!best||total<best.total)best={point:candidate,total};}
  const distances=points.map(point=>haversineM(best.point,point)).sort((a,b)=>a-b);
  return {point:best.point,medianSpreadM:distances[Math.floor(distances.length/2)],maxSpreadM:distances.at(-1),within500:distances.filter(d=>d<=500).length};
}

if(command==='sample'){
  if(positional.length!==1)usage();
  if(existsSync(manifestPath)){console.error('A batch with this name exists. Choose another --name.');process.exit(1);}
  const root=resolve(positional[0]),perFolder=Number(flags['per-folder']||10),seed=Number(flags.seed||42);
  if(!(perFolder>0))usage();
  const stages=paperStages(process.env,{handoffModel:null});
  const known=new Map(store.listRuns().map(run=>[run.image.sha256,run]));
  const items=[],folders=[];
  // --folders a,b: only these folders. --exclude round1,round2: leave out photos those batches drew.
  const only=typeof flags.folders==='string'?new Set(flags.folders.split(',').map(name=>name.trim()).filter(Boolean)):null;
  const taken=new Set();
  for(const name of typeof flags.exclude==='string'?flags.exclude.split(',').map(part=>part.trim()).filter(Boolean):[]){
    const path=resolve(batchDirectory,`${name}.json`);
    if(!existsSync(path)){console.error(`Batch not found: ${name}`);process.exit(1);}
    for(const item of JSON.parse(readFileSync(path,'utf8')).items)taken.add(`${item.folder}/${item.file}`);
  }
  for(const folder of readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>entry.name).sort()){
    if(only&&!only.has(folder))continue;
    const files=readdirSync(join(root,folder)).filter(name=>IMAGE.test(name)&&!taken.has(`${folder}/${name}`)).sort();
    const drawn=shuffled(files,seed).slice(0,perFolder).sort();
    folders.push({folder,files:files.length,drawn:drawn.length});
    for(const file of drawn){
      const path=join(root,folder,file),prepared=await prepareImage(readFileSync(path));
      // The same photo twice (by analysis-image hash) is one record.
      let run=known.get(prepared.image.sha256);
      if(!run){run=store.registerRun(prepared.image,prepared.bytes,stages);known.set(prepared.image.sha256,run);}
      items.push({folder,file,sha256:prepared.image.sha256,runId:run.id,gps:(await gpsOf(path)).status});
    }
  }
  writeFileSync(manifestPath,JSON.stringify({name:flags.name,createdAt:new Date().toISOString(),root,seed,perFolder,folders,items},null,2));
  console.log(JSON.stringify({batch:flags.name,photos:items.length,records:new Set(items.map(item=>item.runId)).size,manifest:manifestPath}));
  for(const entry of folders)console.log(JSON.stringify({...entry,withGps:items.filter(item=>item.folder===entry.folder&&item.gps==='found').length}));
  console.log(items.map(item=>item.runId).join(' '));
}else if(command==='score'){
  if(!existsSync(manifestPath))usage();
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const radiusM=flags.radius===undefined?DEFAULT_RADIUS_M:Number(flags.radius),areaRadiusM=Number(flags['area-radius']||1000);
  const geocoder=GEOCODERS.naver;
  // batches/districts.json: {"<folder>":{"province":"서울|Seoul","district":"마포구|Mapo-gu"}} (regular
  // expression sources). The district each folder's place is in, as told by the photos' owner. With it
  // every prediction also gets districtScore: does the geocoded address fall in that district?
  const districtsPath=resolve(batchDirectory,'districts.json');
  const districts=existsSync(districtsPath)?JSON.parse(readFileSync(districtsPath,'utf8')):{};
  // Reference point per folder, from every photo in the folder (not only the drawn ones).
  const references=new Map();
  for(const {folder} of manifest.folders){
    const points=[];
    for(const file of readdirSync(join(manifest.root,folder)).filter(name=>IMAGE.test(name))){const gps=await gpsOf(join(manifest.root,folder,file));if(gps.status==='found')points.push(gps);}
    if(points.length){
      const centre=medoid(points);
      references.set(folder,{basis:'folder_gps_medoid',point:centre.point,photosWithGps:points.length,medianSpreadM:Math.round(centre.medianSpreadM),maxSpreadM:Math.round(centre.maxSpreadM),photosWithin500M:centre.within500});
    }else{
      const query=`${folder.split('_').at(-1)}역`,found=await naverPlaceSearch(query);
      if(isBlocking(found.status)){console.log(JSON.stringify({status:'place_search_unavailable',reason:found.status}));process.exit(2);}
      references.set(folder,found.places?.length?{basis:'folder_name_place',point:found.places[0],query,placeTitle:found.places[0].title,photosWithGps:0}:{basis:'none',point:null,query,photosWithGps:0});
    }
    const {point,...shown}=references.get(folder);console.log(JSON.stringify({folder,...shown}));
  }
  manifest.references=Object.fromEntries([...references].map(([folder,{point,...shown}])=>[folder,shown]));
  for(const item of manifest.items){
    let run=store.getRun(item.runId);
    const path=join(manifest.root,item.folder,item.file),gps=await gpsOf(path),reference=references.get(item.folder);
    if(gps.status==='found'){
      const result=await scoreRun({store,run,truth:gps,geocoder:'naver',geocode:geocoder.geocode,radiusM,matchesPaperGeocoder:false,force:Boolean(flags.force)});
      if(result.blocked){console.log(JSON.stringify({status:'geocoder_unavailable',reason:result.blocked}));process.exit(2);}
      run=result.run;
    }
    for(const prediction of run.predictions||[]){
      if(prediction.status==='answered'&&reference.point&&(!prediction.folderScore||flags.force)){
        const candidates=[];
        for(const address of prediction.addressList){
          const found=await geocoder.geocode(address);
          if(isBlocking(found.status)){console.log(JSON.stringify({status:'geocoder_unavailable',reason:found.status}));process.exit(2);}
          candidates.push({geocodeStatus:found.status,queryForm:found.queryForm??null,province:found.province??null,district:found.district??null,distanceM:found.status==='resolved'?geodesicDistanceM({latitude:found.latitude,longitude:found.longitude},{latitude:reference.point.latitude,longitude:reference.point.longitude}):null});
        }
        const best=candidates.filter(candidate=>candidate.distanceM!==null).sort((a,b)=>a.distanceM-b.distanceM)[0]??null;
        const {point,...shown}=reference;
        prediction.folderScore={scoredAt:new Date().toISOString(),status:best?'scored':'geocode_failed',geocoder:'naver',folder:item.folder,reference:shown,radiusM:areaRadiusM,candidates,distanceM:best?.distanceM??null,withinRadius:best?best.distanceM<=areaRadiusM:null};
        const expected=districts[item.folder];
        if(expected){
          const resolved=candidates.filter(candidate=>candidate.geocodeStatus==='resolved');
          const inDistrict=candidate=>new RegExp(expected.province,'i').test(candidate.province||'')&&new RegExp(`^(${expected.district})$`,'i').test(candidate.district||'');
          prediction.districtScore={scoredAt:new Date().toISOString(),status:resolved.length?'scored':'geocode_failed',geocoder:'naver',folder:item.folder,expected,predicted:resolved.map(candidate=>`${candidate.province} ${candidate.district}`),match:resolved.length?resolved.some(inDistrict):null};
        }
        store.saveRun(run);
      }
    }
    const prediction=(run.predictions||[]).at(-1)??null;
    Object.assign(item,{gps:gps.status,prediction:prediction?.status??'none',clues:prediction?.clueList?.length??null,
      exifDistanceM:prediction?.score?.distanceM==null?null:Math.round(prediction.score.distanceM),exifWithin:prediction?.score?.withinRadius??null,exifGeocode:prediction?.score?.status??null,
      folderDistanceM:prediction?.folderScore?.distanceM==null?null:Math.round(prediction.folderScore.distanceM),folderWithin:prediction?.folderScore?.withinRadius??null,folderGeocode:prediction?.folderScore?.status??null,
      districtPredicted:prediction?.districtScore?.predicted?.[0]??null,districtMatch:prediction?.districtScore?.match??null});
    console.log(JSON.stringify({folder:item.folder,file:item.file,runId:item.runId.slice(0,8),gps:item.gps,prediction:item.prediction,clues:item.clues,exifDistanceM:item.exifDistanceM,exifWithin:item.exifWithin,folderDistanceM:item.folderDistanceM,folderWithin:item.folderWithin,geocode:item.folderGeocode}));
  }
  manifest.scoredAt=new Date().toISOString();manifest.radiusM=radiusM;manifest.areaRadiusM=areaRadiusM;
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2));
}else if(command==='select'){
  if(typeof flags.batches!=='string')usage();
  const seed=Number(flags.seed||42);
  const pairs=value=>Object.fromEntries((typeof value==='string'?value.split(','):[]).map(part=>part.split('=')).filter(pair=>pair.length===2).map(([key,rest])=>[key.trim(),rest.trim()]));
  const caps=pairs(flags.cap),groupAddress=pairs(flags['group-address']);
  const entries=[],inBatches=new Set();
  for(const name of flags.batches.split(',').map(part=>part.trim()).filter(Boolean)){
    const batch=JSON.parse(readFileSync(resolve(batchDirectory,`${name}.json`),'utf8'));
    for(const item of batch.items){
      if(inBatches.has(item.runId))continue;
      inBatches.add(item.runId);
      const hasGps=item.gps==='found',distanceM=hasGps?item.exifDistanceM:item.folderDistanceM;
      const near=distanceM!==null&&distanceM!==undefined&&distanceM<=1000&&item.districtMatch===true;
      const basis=hasGps&&item.exifWithin===true?'exif_500m':near?(hasGps?'exif_1000m_and_district':'folder_1000m_and_district'):null;
      entries.push({runId:item.runId,batch:name,group:item.folder,gps:item.gps,distanceM:distanceM??null,districtMatch:item.districtMatch??null,clues:item.clues,basis,eligible:Boolean(basis)});
    }
  }
  // Records scored before the batches existed (the pilot photos): their own 500 m score decides.
  for(const run of store.listRuns()){
    if(inBatches.has(run.id))continue;
    const prediction=(run.predictions||[]).filter(candidate=>candidate.status==='answered'&&candidate.clueList?.length).at(-1);
    if(!prediction?.score)continue;
    const eligible=prediction.score.status==='scored'&&prediction.score.withinRadius===true,address=prediction.addressList?.[0]||'';
    const group=Object.entries(groupAddress).find(([,pattern])=>new RegExp(pattern,'i').test(address))?.[0]??'earlier';
    entries.push({runId:run.id,batch:null,group,gps:'found',distanceM:prediction.score.distanceM===null?null:Math.round(prediction.score.distanceM),districtMatch:null,clues:prediction.clueList.length,basis:eligible?'exif_500m':null,eligible});
  }
  for(const entry of entries)entry.included=entry.eligible;
  for(const [group,limit] of Object.entries(caps)){
    const kept=new Set(shuffled(entries.filter(entry=>entry.eligible&&entry.group===group).map(entry=>entry.runId).sort(),seed).slice(0,Number(limit)));
    for(const entry of entries)if(entry.eligible&&entry.group===group&&!kept.has(entry.runId)){entry.included=false;entry.droppedByCap=true;}
  }
  const directory=resolve(store.directory,'clueminer-input');mkdirSync(directory,{recursive:true});
  const path=resolve(directory,`${flags.name}.json`);
  if(existsSync(path)){console.error('A selection with this name exists. Choose another --name.');process.exit(1);}
  const rule='with a position: within 500 m, or within 1,000 m and in the folder district; without a position: within 1,000 m of the folder reference and in the folder district; records outside the batches: stored score within its radius';
  writeFileSync(path,JSON.stringify({name:flags.name,createdAt:new Date().toISOString(),rule,batches:flags.batches,caps,groupAddress,seed,entries},null,2));
  const groups={};
  for(const entry of entries){
    const group=groups[entry.group]??={considered:0,eligible:0,included:0,clues:0};
    group.considered++;if(entry.eligible)group.eligible++;
    if(entry.included){group.included++;group.clues+=entry.clues;}
  }
  for(const [group,counts] of Object.entries(groups))console.log(JSON.stringify({group,...counts}));
  const included=entries.filter(entry=>entry.included);
  console.log(JSON.stringify({selection:flags.name,considered:entries.length,eligible:entries.filter(entry=>entry.eligible).length,included:included.length,clues:included.reduce((sum,entry)=>sum+entry.clues,0),file:path}));
}else usage();
