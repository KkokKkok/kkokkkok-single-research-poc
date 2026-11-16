// Not a paper step. A place search that needs no true position: each text quoted from a photo is
// typed into the map search and only COUNTED — how many places come back, and how many of them lie
// in the area the photo is assumed to be in. Nothing is compared with where the photo was taken, so
// this also runs for photos without a position. No coordinate is stored, only the counts.
// What it is for (measured on 2026-11-15, 244 searched texts of 85 photos with a known position):
// a text with no result in the area never led to the place (0 of 114), so its clue need not be shown.
// The opposite does not hold: results in the area do not make a text risky (the best such rule was
// right 58% of the time), so a count never raises a clue's label.
import { isBlocking } from './paper-score.mjs';
import { placeQueries,withShorterQueries } from './paper-runner.mjs';

// A box around Seoul, rough: it takes in a little of the neighbouring cities. Every photo so far is
// from Seoul; for photos from elsewhere this has to become the city the address guess names.
export const PROBE_AREA={name:'seoul_box',south:37.41,north:37.71,west:126.76,east:127.19};
export const inProbeArea=(place,area=PROBE_AREA)=>place.latitude>=area.south&&place.latitude<=area.north&&place.longitude>=area.west&&place.longitude<=area.east;

// One text. Returns {blocked:true,status} when the service cannot be used, otherwise the counts.
export async function probeText({query,search,area=PROBE_AREA}){
  const found=await search(query);
  if(isBlocking(found.status))return {blocked:true,status:found.status};
  const places=found.places||[];
  return {searchedAt:new Date().toISOString(),service:'naver_apihub_local',query,status:found.status,area:area.name,resultCount:places.length,inAreaCount:places.filter(place=>inProbeArea(place,area)).length};
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
