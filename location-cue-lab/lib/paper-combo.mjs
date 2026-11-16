// EVALUATION ONLY, and not a paper step. Combined place search: do two things from one photo give
// the place away together?
// A shop name of a chain finds dozens of branches, so it reveals nothing alone. Together with
// something else from the same photo it can: another text seen in it, or the area the address guess
// pointed to. Both are tried here the way a person with a map would, and judged like the single
// search: against the true position, which is never sent and never stored.
// The address guess is used INTERNALLY only: its district names the area to search in and its point
// picks among the results. No coordinate goes into the result. (The district name does, as `area`:
// the proof-of-concept viewer shows it; a product front end must not receive it.)
import { DEFAULT_RADIUS_M,geodesicDistanceM,isBlocking } from './paper-score.mjs';

// NAVER's place search needs Korean area names (a romanized "Mapo-gu" finds nothing; checked on
// 2026-11-15 with a public query), and the geocoder returns English names for a romanized address,
// hence this table. Seoul only: a guess elsewhere gets no area search.
export const SEOUL_DISTRICTS={'Jongno-gu':'종로구','Jung-gu':'중구','Yongsan-gu':'용산구','Seongdong-gu':'성동구','Gwangjin-gu':'광진구','Dongdaemun-gu':'동대문구','Jungnang-gu':'중랑구','Seongbuk-gu':'성북구','Gangbuk-gu':'강북구','Dobong-gu':'도봉구','Nowon-gu':'노원구','Eunpyeong-gu':'은평구','Seodaemun-gu':'서대문구','Mapo-gu':'마포구','Yangcheon-gu':'양천구','Gangseo-gu':'강서구','Guro-gu':'구로구','Geumcheon-gu':'금천구','Yeongdeungpo-gu':'영등포구','Dongjak-gu':'동작구','Gwanak-gu':'관악구','Seocho-gu':'서초구','Gangnam-gu':'강남구','Songpa-gu':'송파구','Gangdong-gu':'강동구'};
// The Korean district name of a geocoded point, or null outside Seoul or for an unknown name.
export function seoulDistrictKo(found){
  if(!found||!/서울|Seoul/i.test(found.province||''))return null;
  const name=String(found.district||'').trim();
  return SEOUL_DISTRICTS[name]??(Object.values(SEOUL_DISTRICTS).includes(name)?name:null);
}
// Good enough to compare candidates with each other; distances that are reported use the geodesic engine.
export function haversineM(a,b){
  const rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;
  return 2*6371008.8*Math.asin(Math.sqrt(h));
}

// texts: [{query,clueIds,tier,basis}] the photo's quoted texts that did NOT reveal the place alone.
// basis: the text comes from a clue that is low alone but material for a combination (a chain's name;
// paper-risk-tiers.mjs COMBINATION_BASIS). Such a text is combined like a tier A text (2026-11-16):
// two chains seen together, or a chain in the guessed district, are what the rule sheet's chapter 3 is about.
// guess: {latitude,longitude,districtKo} from the address guess, or null (no guess, or outside Seoul).
// Returns {blocked:true,status} or {searches:[...]}. One entry per attempt:
//   kind 'pair'  method 'co_location'  each text names places, and one of each lie within pairRadiusM
//   kind 'pair'  method 'joint_query'  both texts typed as one query (only when no co-location was found)
//   kind 'area'  method 'district_nearest_to_guess'  "<district> <text>", taking the result nearest the guessed point
// withinRadius: the place arrived at is within radiusM of the true position.
export async function combinationSearches({texts,truth,search,guess=null,distance=geodesicDistanceM,radiusM=DEFAULT_RADIUS_M,pairRadiusM=300,maxTexts=6,maxPairs=10,maxArea=6}){
  const order={A:0,B:2,C:3},rank=text=>text.tier!=='A'&&text.basis?1:order[text.tier]??4,leads=text=>text.tier==='A'||Boolean(text.basis);
  const chosen=[...texts].sort((a,b)=>rank(a)-rank(b)).slice(0,maxTexts);
  const toTruth=point=>distance({latitude:point.latitude,longitude:point.longitude},{latitude:truth.latitude,longitude:truth.longitude});
  const found=new Map(),searches=[];
  const lookUp=async query=>{
    if(!found.has(query)){
      const result=await search(query);
      if(isBlocking(result.status))return null;
      found.set(query,result.places||[]);
    }
    return found.get(query);
  };
  const entry=(kind,method,members,fields)=>({searchedAt:new Date().toISOString(),service:'naver_apihub_local',kind,method,texts:members.map(member=>member.query),clueIds:members.map(member=>member.clueIds),radiusM,...fields});
  // Pairs: at least one of the two is tier A or a combination basis.
  let pairs=0;
  for(let i=0;i<chosen.length&&pairs<maxPairs;i++)for(let j=i+1;j<chosen.length&&pairs<maxPairs;j++){
    const a=chosen[i],b=chosen[j];
    if(!leads(a)&&!leads(b))continue;
    pairs++;
    const placesA=await lookUp(a.query),placesB=await lookUp(b.query);
    if(!placesA||!placesB)return {blocked:true,status:'place_search_unavailable'};
    let best=null;
    for(const pa of placesA)for(const pb of placesB){const gapM=haversineM(pa,pb);if(!best||gapM<best.gapM)best={pa,pb,gapM};}
    if(best&&best.gapM<=pairRadiusM){
      const distanceM=toTruth({latitude:(best.pa.latitude+best.pb.latitude)/2,longitude:(best.pa.longitude+best.pb.longitude)/2});
      searches.push(entry('pair','co_location',[a,b],{status:'found',pairRadiusM,gapM:Math.round(best.gapM),placeTitles:[best.pa.title,best.pb.title],distanceM,withinRadius:distanceM<=radiusM}));
      continue;
    }
    const joint=await lookUp(`${a.query} ${b.query}`);
    if(!joint)return {blocked:true,status:'place_search_unavailable'};
    const distanceM=joint.length?toTruth(joint[0]):null;
    searches.push(entry('pair','joint_query',[a,b],{status:joint.length?'found':'no_result',query:`${a.query} ${b.query}`,placeTitles:joint.slice(0,1).map(place=>place.title),distanceM,withinRadius:joint.length?distanceM<=radiusM:null}));
  }
  // A text together with the district the address guess pointed to.
  // guessWithinRadius: the guessed point was already that close to the true position. Then taking the
  // result nearest the guess lands near the truth whatever the text says, so the search shows nothing
  // about the text; such an entry is kept for the record but is not evidence against the clue.
  if(guess?.districtKo){
    const guessWithinRadius=toTruth(guess)<=radiusM;
    for(const text of chosen.filter(leads).slice(0,maxArea)){
      const places=await lookUp(`${guess.districtKo} ${text.query}`);
      if(!places)return {blocked:true,status:'place_search_unavailable'};
      if(!places.length){searches.push(entry('area','district_nearest_to_guess',[text],{status:'no_result',area:guess.districtKo,guessWithinRadius,placeTitles:[],distanceM:null,withinRadius:null}));continue;}
      const ranked=places.map((place,index)=>({place,rank:index+1,fromGuessM:haversineM(place,guess)})).sort((p,q)=>p.fromGuessM-q.fromGuessM);
      const distanceM=toTruth(ranked[0].place);
      searches.push(entry('area','district_nearest_to_guess',[text],{status:'found',area:guess.districtKo,guessWithinRadius,resultCount:places.length,pickedRank:ranked[0].rank,placeTitles:[ranked[0].place.title],distanceM,withinRadius:distanceM<=radiusM}));
    }
  }
  return {searches};
}

// After the single-text place search of one record: tries the texts that did not give the place away
// alone, in combination. The guess is geocoded here and used only to choose the area and to pick
// among results. tierOf: clue => 'A'|'B'|'C'. basisOf: clue => true for a combination basis. Replaces earlier combination searches of the record.
export async function searchCombinationsRun({store,run,truth,search,geocode,tierOf,basisOf=()=>false,distance,radiusM,force=false}){
  if(!run.placeSearches||(run.comboSearches&&!force))return {run,blocked:null};
  const tierOfClue=new Map(run.clues.map(clue=>[clue.id,tierOf(clue)])),basisIds=new Set(run.clues.filter(basisOf).map(clue=>clue.id));
  const texts=run.placeSearches.filter(single=>!single.topWithinRadius).map(single=>({query:single.query,clueIds:single.clueIds||[],
    tier:['A','B','C'].find(tier=>(single.clueIds||[]).some(id=>tierOfClue.get(id)===tier))??'C',basis:(single.clueIds||[]).some(id=>basisIds.has(id))}));
  let guess=null;
  const address=(run.predictions||[]).filter(prediction=>prediction.status==='answered').at(-1)?.addressList?.[0];
  if(address){
    const found=await geocode(address);
    if(isBlocking(found.status))return {run,blocked:found.status};
    const districtKo=found.status==='resolved'?seoulDistrictKo(found):null;
    if(districtKo)guess={latitude:found.latitude,longitude:found.longitude,districtKo};
  }
  const result=await combinationSearches({texts,truth,search,guess,...(distance?{distance}:{}),...(radiusM?{radiusM}:{})});
  if(result.blocked)return {run,blocked:result.status};
  run.comboSearches=result.searches;run.comboSearchInfo={searchedAt:new Date().toISOString(),texts:texts.length,usedGuessArea:Boolean(guess)};
  return {run:store.saveRun(run),blocked:null};
}
