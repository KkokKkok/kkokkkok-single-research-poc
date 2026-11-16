// Not a paper step. A place search that needs no true position: each text quoted from a photo is
// typed into the map search and only COUNTED — how many places come back, and how many of them lie
// in the area the photo is assumed to be in. Nothing is compared with where the photo was taken, so
// this also runs for photos without a position. No coordinate is stored, only the counts.
// What it is for (measured on 2026-11-15, 244 searched texts of 85 photos with a known position):
// a text with no result in the area never led to the place (0 of 114), so its clue need not be shown.
// The opposite does not hold: results in the area do not make a text risky (the best such rule was
// right 58% of the time), so a count never raises a clue's label.
import { isBlocking,PLACE_SEARCH_LIMIT } from './paper-score.mjs';
import { clueTier,isCombinationBasis } from './paper-risk-tiers.mjs';
import { placeQueries,withShorterQueries } from './paper-runner.mjs';

// A box around Seoul, rough: it takes in a little of the neighbouring cities. Every photo so far is
// from Seoul; for photos from elsewhere this has to become the city the address guess names.
export const PROBE_AREA={name:'seoul_box',south:37.41,north:37.71,west:126.76,east:127.19};
export const inProbeArea=(place,area=PROBE_AREA)=>place.latitude>=area.south&&place.latitude<=area.north&&place.longitude>=area.west&&place.longitude<=area.east;

// One text. Returns {blocked:true,status} when the service cannot be used, otherwise the counts.
// limit/capped (2026-11-16): the search returns at most `limit` places, so a count equal to it means
// "that many or more". Stored so that a later analysis does not read 5 as exactly five places.
export async function probeText({query,search,area=PROBE_AREA,limit=PLACE_SEARCH_LIMIT}){
  const found=await search(query);
  if(isBlocking(found.status))return {blocked:true,status:found.status};
  const places=found.places||[];
  return {searchedAt:new Date().toISOString(),service:'naver_apihub_local',query,status:found.status,area:area.name,resultCount:places.length,inAreaCount:places.filter(place=>inProbeArea(place,area)).length,limit,capped:places.length>=limit};
}

// Every quoted text of one record (the same texts the place search uses). Replaces earlier probes.
// Returns {run,blocked}.
export async function probePlacesRun({store,run,search,area=PROBE_AREA,force=false}){
  if(!['extracted','classified'].includes(run.status))return {run,blocked:null};
  if(run.placeProbes&&!force)return {run,blocked:null};
  const probes=[];
  for(const entry of placeQueries(run)){
    // A text that finds nothing is typed again in shorter forms before it counts as "not on the map".
    const probe=await withShorterQueries(entry.query,query=>probeText({query,search,area}));
    if(probe.blocked)return {run,blocked:probe.status};
    probes.push({...probe,clueIds:entry.clueIds});
  }
  run.placeProbes=probes;
  return {run:store.saveRun(run),blocked:null};
}

// The stored counts of every probed record as flat rows, one per (record, clue, quoted text), for the
// cumulative analysis: photos taken near each other are grouped there, and these rows say how many
// places each of their clues still fits. No position is in a row (none is stored): the analysis brings
// its own positions and joins on imageSha256, the hash of the analysis image.
// A probe stored before 2026-11-16 has no limit: it was 5.
export function probeLedger(runs){
  const rows=[];
  for(const run of runs){
    const clueOf=new Map((run.clues||[]).map(clue=>[clue.id,clue]));
    for(const probe of run.placeProbes||[])for(const clueId of probe.clueIds||[]){
      const clue=clueOf.get(clueId),limit=probe.limit??PLACE_SEARCH_LIMIT;
      rows.push({recordId:run.id,imageSha256:run.image?.sha256??null,recordCreatedAt:run.createdAt??null,clueId,category:clue?.taxonomy?.name??null,tier:clue?clueTier(clue):null,combinationBasis:clue?isCombinationBasis(clue):false,
        text:probe.query,searchedAs:probe.searchedAs??probe.query,status:probe.status??null,area:probe.area??null,resultCount:probe.resultCount??null,inAreaCount:probe.inAreaCount??null,limit,capped:probe.capped??(probe.resultCount??0)>=limit,searchedAt:probe.searchedAt??null});
    }
  }
  return rows;
}
