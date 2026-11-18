// EVALUATION ONLY, not a paper step (added 2026-11-17 at the owner's request). When the address guess
// (the paper's CoT prompt, paper-runner.mjs locateRun) found the place, the clues it said it used are
// one combination that gave the place away, and have to be coverable: a text clue by its OCR outline,
// an object clue by its mask. The guess lists its clues in its own words, so a text-only model call
// says which Detector clue each one is; the photo is not sent and no place is named.
// The guess's clue list is the model's own account: it does not prove which clue decided the answer.
// It is the best record of "what was used" there is, and the owner chose to cover all of it.
//   run.guessClues = {version, createdAt, model, promptSha256, answer, attempts,
//                     prediction:{createdAt, model, topN}, matches:[{index, text, clueIds}]}
// The matching belongs to one prediction (its createdAt): a newer guess makes it stale, and a guess
// that no longer counts as a hit (rescored) makes it inert. paper-rules.mjs guessCombination turns it
// into the combination that region linking, pointing and masks follow.
import { createHash } from 'node:crypto';

export const GUESS_MATCH_VERSION='guess-clues-v1';
const metres=value=>value>=1000?`${(value/1000).toFixed(1)}km`:`${Math.round(value)}m`;

// The latest prediction of a record that has a status: the one the verdict below judges.
export const latestPrediction=run=>(run.predictions||[]).filter(candidate=>candidate.status).at(-1)??null;
// The address guess of one record, judged by the rule agreed on 2026-11-14: with a position, within
// 500 m, or within 1,000 m and in the right district; without one, within 1,000 m of the folder's
// reference point and in the right district. Returns null when the record has no guess.
export function guessVerdict(run){
  const prediction=latestPrediction(run);
  if(!prediction)return null;
  const district=prediction.districtScore?.match??null,exif=prediction.score,folder=prediction.folderScore;
  let basis,distanceM=null,hit=false;
  if(exif){
    basis='exif';
    if(exif.status==='scored'){distanceM=exif.distanceM;hit=distanceM<=500||(distanceM<=1000&&district===true);}
  }else if(folder){
    basis='folder';
    if(folder.status==='scored'){distanceM=folder.distanceM;hit=distanceM<=1000&&district===true;}
  }else basis='none';
  const where=basis==='none'?'정답 없음':distanceM===null?'답을 좌표로 바꾸지 못함':`${basis==='exif'?'실제 위치':'폴더 기준점'}에서 ${metres(distanceM)}`;
  return {hit,basis,distanceM:distanceM===null?null:Math.round(distanceM),district,
    text:`${basis==='none'?'채점 안 함':hit?'맞힘':'못 맞힘'} · ${where}${district===true?' · 구 일치':district===false?' · 구 불일치':''}`,
    addresses:prediction.addressList||[],clues:prediction.clueList||[]};
}

export const GUESS_MATCH_TEMPLATE=`Two lists describe the same photograph. List A was written by someone who worked out where the photo was taken and lists the clues they used. List B was written separately and lists clues seen in the photo. You do not see the photo. Never name or guess the place.

For each entry of list A, give the ids of list B that describe the same thing in the photo (the same sign, the same text, the same object or view). Give several ids when the entry covers several of them, and an empty list when list B has nothing about it. Do not match by topic alone: "Korean text on signs" is not the same thing as a particular sign's name.

List A:
<<GUESS>>

List B:
<<CLUES>>

Answer with only this JSON, every key of list A exactly once:
\`\`\`json
{"guess-0": ["clue-1"], "guess-1": [], "guess-2": ["clue-3", "clue-4"]}
\`\`\`
`;
export const guessMatchPrompt=(guessClues,clues)=>GUESS_MATCH_TEMPLATE
  .replace('<<GUESS>>',()=>guessClues.map((text,index)=>`guess-${index}: ${text}`).join('\n'))
  .replace('<<CLUES>>',()=>clues.map(clue=>`${clue.id}: ${clue.detail}`).join('\n'));

// [[clueId,...] per guess clue]. A malformed answer, a missing key or an unknown clue id is an error
// (the call is repeated): an id the model made up would cover nothing.
export function parseGuessMatch(answer,count,clueIds){
  const text=String(answer||''),fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(text.match(/\{[\s\S]*\}/)||[])[0],text.trim()]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed)throw new Error('GUESS_MATCH_INVALID');
  const known=new Set(clueIds);
  return Array.from({length:count},(_,index)=>{
    const ids=parsed[`guess-${index}`];
    if(!Array.isArray(ids))throw new Error('GUESS_MATCH_INCOMPLETE');
    if(ids.some(id=>!known.has(id)))throw new Error('GUESS_MATCH_UNKNOWN_CLUE');
    return [...new Set(ids)];
  });
}

// Whether a record's guess is to be matched now: a hit with a clue list, and no matching yet for it.
export function needsGuessMatch(run,{force=false}={}){
  const prediction=latestPrediction(run);
  if(!run.clues?.length||!prediction?.clueList?.length||!guessVerdict(run)?.hit)return false;
  return force||run.guessClues?.prediction?.createdAt!==prediction.createdAt;
}

// llm: async ({model,reasoningEffort,text,attempt}) => {text,raw}. Returns run.guessClues.
export async function matchGuessClues({run,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{}}){
  const prediction=latestPrediction(run),prompt=guessMatchPrompt(prediction.clueList,run.clues),ids=run.clues.map(clue=>clue.id);
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'guessMatch',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{
      const matched=parseGuessMatch(text,prediction.clueList.length,ids);
      return {version:GUESS_MATCH_VERSION,createdAt:new Date().toISOString(),verification:'none',model,promptSha256:createHash('sha256').update(prompt).digest('hex'),answer:text,attempts:attempt,
        prediction:{createdAt:prediction.createdAt,model:prediction.model,topN:prediction.topN},
        matches:prediction.clueList.map((guess,index)=>({index,text:guess,clueIds:matched[index]}))};
    }catch(error){lastError=error;}
  }
  throw lastError;
}

// The clues the hit guess used, as far as the matching says: {clueIds, verdict, unmatched} or null when
// the guess is not a hit or the matching is missing or belongs to another prediction.
export function guessUsedClues(run){
  const verdict=guessVerdict(run),prediction=latestPrediction(run),match=run.guessClues;
  if(!verdict?.hit||!match||match.prediction?.createdAt!==prediction.createdAt)return null;
  const present=new Set((run.clues||[]).map(clue=>clue.id));
  const clueIds=[...new Set(match.matches.flatMap(item=>item.clueIds))].filter(id=>present.has(id));
  return {clueIds,verdict,unmatched:match.matches.filter(item=>!item.clueIds.length).map(item=>item.text)};
}

// ---------- Which clue of the hit guess gives the place away by itself? (added 2026-11-18) ----------
// The guess lists everything it looked at, so raising all of it overstates most clues: a museum's name
// finds the museum, and the trees beside it do not. Each clue is therefore tried alone: a text-only
// call gets the clue's sentence, nothing else, and gives the address that sentence points to, or none.
// A clue counts as found alone (`hit`) when that address lies within `radiusM` of the address the hit
// guess gave. The reference is the guess's own address, already judged right, so the true position is
// not needed here; the price is that the two errors add up, which the radius leaves room for.
// A clue that is itself a conclusion about the place ("most likely the lobby of X Hall") is not tried:
// it was written by a model that saw the whole photo, and would always find the place.
// Limit: a clue that describes something visible can still carry a name the Detector recognised from
// the rest of the photo. Such a clue passes; nothing here can tell where the name came from.
//   run.guessSolo = {version, createdAt, model, promptSha256, answer, attempts, prediction:{createdAt},
//                    radiusM, reference:'guess_address', geocoder,
//                    clues:[{clueId, kind:'observation'|'conclusion', address, geocodeStatus, distanceM, hit}]}
export const GUESS_SOLO_VERSION='guess-solo-v1';
export const SOLO_RADIUS_M=500;
export const GUESS_SOLO_TEMPLATE=`Each entry below is one clue that was written about a photograph. You do not see the photograph. Treat every entry entirely on its own: when you judge one entry, the other entries do not exist.

For each entry give:
- "kind": "conclusion" when the entry is itself a statement or guess of where the photo was taken (it gives the place as its result, like "this is most likely the lobby of X Hall in Y"), and "observation" when it describes something that is visible in the photo (a sign and its text, an object, a building, a view), even if it says what that thing is.
- "address": only for an observation. If that one thing alone is enough to find a single place, the most specific address of that place you can give, in this format: [Street Number] [Street Name] [Street Type], [City], [State Abbreviation] [ZIP Code]. If the entry alone fits many places (a kind of tree, a common style, a nationwide chain without a branch name, a language), give null. Do not guess a place the entry does not single out. For a conclusion give null.

Entries:
<<CLUES>>

Answer with only this JSON, every id exactly once:
\`\`\`json
{"clue-0": {"kind": "observation", "address": "1 Example-ro, Example-gu, Seoul 00000"}, "clue-1": {"kind": "observation", "address": null}, "clue-2": {"kind": "conclusion", "address": null}}
\`\`\`
`;
export const guessSoloPrompt=clues=>GUESS_SOLO_TEMPLATE.replace('<<CLUES>>',()=>clues.map(clue=>`${clue.id}: ${clue.detail}`).join('\n'));
// {clueId:{kind,address}}. A malformed answer, a missing id or an unknown kind is an error (the call is repeated).
export function parseGuessSolo(answer,clueIds){
  const text=String(answer||''),fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(text.match(/\{[\s\S]*\}/)||[])[0],text.trim()]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed)throw new Error('GUESS_SOLO_INVALID');
  return Object.fromEntries(clueIds.map(id=>{
    const entry=parsed[id];
    if(!entry||!['observation','conclusion'].includes(entry.kind))throw new Error('GUESS_SOLO_INCOMPLETE');
    const address=entry.kind==='observation'&&typeof entry.address==='string'&&entry.address.trim()?entry.address.trim().slice(0,300):null;
    return [id,{kind:entry.kind,address}];
  }));
}
// Tries each of `targets` (clues of the record) alone. geocode: async address => {status,latitude,longitude}
// (paper-score.mjs GEOCODERS); blocking: status => true when the geocoder cannot be used at all;
// distance: (from,to) => metres. Returns {solo} to store as run.guessSolo, or {blocked:status}.
export async function testGuessSolo({run,targets,model,reasoningEffort=null,llm,geocode,geocoder,distance,blocking=()=>false,radiusM=SOLO_RADIUS_M,attempts=2,onCall=()=>{}}){
  const prediction=latestPrediction(run),base={version:GUESS_SOLO_VERSION,createdAt:new Date().toISOString(),verification:'none',model,prediction:{createdAt:prediction.createdAt},radiusM,reference:'guess_address',geocoder};
  if(!targets.length)return {solo:{...base,promptSha256:null,answer:null,attempts:0,clues:[]}};
  const prompt=guessSoloPrompt(targets),ids=targets.map(clue=>clue.id);
  let answered=null,answer=null,used=0,lastError;
  for(let attempt=1;attempt<=attempts&&!answered;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'guessSolo',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{answered=parseGuessSolo(text,ids);answer=text;used=attempt;}catch(error){lastError=error;}
  }
  if(!answered)throw lastError;
  // Where the hit guess itself points: every address it gave that the geocoder resolves.
  const references=[];
  for(const address of prediction.addressList||[]){
    const found=await geocode(address);
    if(blocking(found.status))return {blocked:found.status};
    if(found.status==='resolved')references.push(found);
  }
  if(!references.length)throw new Error('GUESS_SOLO_NO_REFERENCE');
  const clues=[];
  for(const id of ids){
    const {kind,address}=answered[id],entry={clueId:id,kind,address,geocodeStatus:null,distanceM:null,hit:false};
    if(address){
      const found=await geocode(address);
      if(blocking(found.status))return {blocked:found.status};
      entry.geocodeStatus=found.status;
      if(found.status==='resolved'){
        entry.distanceM=Math.min(...references.map(reference=>distance({latitude:found.latitude,longitude:found.longitude},{latitude:reference.latitude,longitude:reference.longitude})));
        entry.hit=entry.distanceM<=radiusM;
      }
    }
    clues.push(entry);
  }
  return {solo:{...base,promptSha256:createHash('sha256').update(prompt).digest('hex'),answer,attempts:used,clues}};
}
// The solo test of the record's current hit guess, or null when it was not run for this prediction.
export function guessSoloResult(run){
  const prediction=latestPrediction(run),solo=run.guessSolo;
  return solo&&prediction&&solo.prediction?.createdAt===prediction.createdAt?solo:null;
}
