// Evidence normalization (added 2026-11-17). NOT part of the paper.
// The Detector names and words its clues freely, so the same sign photographed twice gets two
// different clue ids, category names and sentences, and one bus is three clues in one photo and two
// in the next. This step rewrites a record's clues as evidence records of a fixed form:
//   one evidence = one subject (the thing it is on) x one aspect (what about it), and for readable
//   text one evidence per string;
//   subject, aspect and attributes come from the fixed lists below;
//   the key is computed here from those fields, never written by the model, so the same evidence
//   in another photo of the place gets the same key.
// A model does the rewriting, from the clue text only (it does not see the photo).
// What the key is for: photos already known to be of one place (from their EXIF position) are analysed
// together, and a clue seen in several of them must be counted once. So the key answers "has this clue
// been counted already", not "is this the same place":
//   text and logo: the string alone. The carrier is left out, because the same word was put on
//   `bus` in one photo and `advertisement` in the next.
//   appearance, layout, activity: subject and aspect. Colours and materials are kept on the record
//   but not in the key: the same road came out red+white and red+yellow. Two different buildings of
//   one place therefore count as one appearance clue.
//   language: the writing system.
//   season, weather, time, layout, activity: the aspect alone, once per place. Measured on 21 photos
//   in 7 groups of one position (2026-11-17): the season of one spot came out autumn, summer and
//   spring, and layout and activity were put on scene, building, interior, road or people by turns.
// groupEvidence() below does the counting, and also joins strings that were read slightly differently.
import { createHash } from 'node:crypto';

export const EVIDENCE_VERSION='evidence-2026-11-17';
// Drafted from the 1,594 clues of the 152 stored photos (their mined categories, by frequency).
export const SUBJECTS={
  shop_sign:'a business\'s own sign or storefront lettering',
  building_sign:'name lettering, plaque or directory of a building or institution',
  address_plate:'house number, building number, road-name plate',
  road_sign:'traffic, direction, warning or place-name sign for road users',
  transit_sign:'station or stop sign, route map, line indicator',
  banner:'banner, flag, placard or poster hung in a public space',
  notice:'printed notice, menu, opening hours, price list, warning on the premises',
  advertisement:'advertisement for a business other than the place it hangs on (on a vehicle, a billboard)',
  product:'merchandise, packaging, cup, receipt, other branded item',
  overlay:'caption, sticker or timestamp added to the photo afterwards',
  bus:'bus',
  train:'train, subway car, tram',
  vehicle:'car, truck, motorbike, bicycle, including number plates',
  boat:'boat or ship',
  building:'a building or the buildings nearby: form, facade, windows, roof',
  skyline:'distant buildings or city outline',
  landmark:'well-known or one-of-a-kind structure, tower, monument',
  bridge:'bridge, overpass, footbridge',
  gate:'gate, archway, entrance structure',
  barrier:'wall, fence, railing, guard rail',
  interior:'an indoor space: design, fixtures, furniture',
  artwork:'mural, sculpture, installation, decoration',
  street_furniture:'bench, bollard, bin, shelter, kiosk, information board',
  lighting:'street lamp or other lighting fixture',
  road:'carriageway: markings, surface, lanes, junction layout',
  pavement:'sidewalk, paving, tactile blocks, kerb, cycle path',
  utility:'pole, overhead wire, manhole, hydrant, camera, traffic signal',
  sports_facility:'pitch, court, track, stadium',
  open_space:'plaza, park, playground',
  vegetation:'trees, plants, planting',
  terrain:'hill, mountain, slope, rock',
  water:'river, stream, sea, lake, fountain',
  sky:'sky, clouds, sun, glow',
  people:'people: clothing, crowd',
  scene:'the photograph as a whole, when the evidence is not on one object',
  other:'none of the above',
};
export const ASPECTS={
  text:'words or numbers that can be read on the subject',
  logo:'a brand or emblem recognised by its mark, not by reading text',
  appearance:'shape, colour, material, style, or what kind of thing it is',
  layout:'where things are relative to each other, or where the camera stood',
  activity:'what people are doing, or what the place is being used for',
  language:'which writing system is visible',
  season:'time of year',
  weather:'weather',
  time:'time of day',
};
// Aspects that say something about the whole photo: the subject is always `scene` and the value is
// one of the listed words.
export const SCENE_VALUES={
  language:['hangul','latin','han','kana','cyrillic','arabic','thai','other'],
  season:['spring','summer','autumn','winter'],
  weather:['clear','cloudy','rain','snow','fog'],
  time:['day','dusk','night'],
};
export const COLORS=['red','orange','yellow','green','blue','purple','pink','brown','black','white','grey','beige','gold','silver'];
export const MATERIALS=['glass','stone','brick','concrete','metal','wood','tile','plastic','fabric','asphalt'];
export const SKIP_REASONS={inference:'a guess of the place, not something seen in the photo',no_evidence:'nothing observable is stated'};

const list=object=>Object.entries(object).map(([code,meaning])=>`- ${code}: ${meaning}`).join('\n');
export const EVIDENCE_TEMPLATE=`Below are clues that were written about one photograph. You do not see the photograph. Rewrite them as evidence records of a fixed form, so that the same thing photographed again is written the same way. Never name or guess the place.

## 1. What one evidence record is
One record = one subject (the thing the evidence is on) x one aspect (what about it).
- Split a clue that speaks of several subjects or aspects. A bus with a route number, an advertisement and a green body is three records: bus/text, advertisement/text, bus/appearance.
- Readable text: one record per string, on the subject that carries it. Write the string exactly as the clue quotes it from the photo, in its original script: no translation, no romanisation, nothing the clue did not quote. Split a quote at separators (|, /, line breaks) into the phrases that stand alone; never split a name. If only part of a word or name was read, write only the readable part and set "textComplete" to false.
- Appearance: at most ONE record per subject. Everything the clues say about how the buildings look is one building/appearance record, even when several clues or several buildings are described.
- When several clues describe the same subject and aspect, write one record and list all their ids.
- A clue that only guesses the place (an estimated or inferred location) is not evidence: list it under "skipped" with reason "inference". A clue that states nothing observable: reason "no_evidence".

## 2. Subjects
${list(SUBJECTS)}

## 3. Aspects
${list(ASPECTS)}

language, season, weather and time are about the whole photograph: their subject is always "scene", and "value" is one of
${Object.entries(SCENE_VALUES).map(([aspect,values])=>`- ${aspect}: ${values.join(', ')}`).join('\n')}
Write one language record per writing system.

## 4. Attributes (appearance records only)
- "color": the one or two dominant colours of the subject, from: ${COLORS.join(', ')}
- "material": the one or two main materials, from: ${MATERIALS.join(', ')}
Use an empty list when the clue does not say. Do not guess.

Clues:
<<CLUES>>

Answer with only this JSON. Every clue id must appear at least once: in the "clueIds" of a record or under "skipped". "text" is set for aspects text and logo only (for a logo: the brand's name as it is usually written), "value" for the four scene aspects only, "color" and "material" for appearance only.
\`\`\`json
{"evidence": [
  {"subject": "bus", "aspect": "text", "text": "동작 21", "textComplete": true, "clueIds": ["clue-1"]},
  {"subject": "bus", "aspect": "appearance", "color": ["green"], "material": [], "clueIds": ["clue-1", "clue-2"]},
  {"subject": "scene", "aspect": "language", "value": "hangul", "clueIds": ["clue-0"]}],
 "skipped": [{"clueId": "clue-9", "reason": "inference"}]}
\`\`\`
`;
export const evidencePrompt=clues=>EVIDENCE_TEMPLATE.replace('<<CLUES>>',()=>JSON.stringify(clues.map(({id,category,detail})=>({id,category,detail})),null,2));

// Text as compared between photos: letters and digits only, in one case and one Unicode form, so
// "동작 21", "동작21" and "CAU." / "cau" each come out the same.
// Accents on Latin letters are dropped as well: the same sign is read with them in one photo and
// without in the next.
export const normalizeText=value=>String(value??'').normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu,'$1').normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu,'');
const fail=code=>new Error(code);
// Aspects that are about the photo, whatever subject the model names: kept on `scene`.
const WHOLE_PHOTO=[...Object.keys(SCENE_VALUES),'layout','activity'];
const picked=(values,allowed)=>[...new Set((Array.isArray(values)?values:[]).filter(value=>allowed.includes(value)))].sort();
export function evidenceKey({subject,aspect,text,value}){
  if(aspect==='text'||aspect==='logo')return `text|${normalizeText(text)}`;
  if(aspect==='language')return `scene|language|${value}`;
  if(WHOLE_PHOTO.includes(aspect))return `scene|${aspect}`;
  return `${subject}|${aspect}`;
}
// The model's answer -> evidence records. A malformed answer, a word outside the lists, a text the
// clue does not contain or a clue left unaccounted for is an error (the call is repeated).
// Records that come out with the same key are one record.
export function parseEvidenceAnswer(answer,clues){
  const raw=String(answer||'');
  const fenced=[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(raw.match(/\{[\s\S]*\}/)||[])[0],raw.trim()]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed||!Array.isArray(parsed.evidence))throw fail('EVIDENCE_ANSWER_INVALID');
  const byId=new Map(clues.map(clue=>[clue.id,clue])),merged=new Map();
  for(const entry of parsed.evidence){
    const ids=[...new Set(Array.isArray(entry?.clueIds)?entry.clueIds:[])];
    if(!ids.length||ids.some(id=>!byId.has(id)))throw fail('EVIDENCE_ANSWER_UNKNOWN_CLUE');
    const aspect=entry.aspect,scene=aspect in SCENE_VALUES,subject=WHOLE_PHOTO.includes(aspect)?'scene':entry.subject;
    if(!(subject in SUBJECTS)||!(aspect in ASPECTS))throw fail('EVIDENCE_ANSWER_VOCABULARY');
    const record={subject,aspect,text:null,textComplete:null,value:null,color:[],material:[]};
    if(aspect==='text'||aspect==='logo'){
      record.text=typeof entry.text==='string'?entry.text.trim():'';record.textComplete=entry.textComplete!==false;
      const normalized=normalizeText(record.text);
      if(!normalized)throw fail('EVIDENCE_ANSWER_TEXT_MISSING');
      // Read text has to be in the clue: a translated or invented string would never match another photo.
      if(aspect==='text'&&!ids.some(id=>normalizeText(`${byId.get(id).category} ${byId.get(id).detail}`).includes(normalized)))throw fail('EVIDENCE_ANSWER_TEXT_NOT_IN_CLUE');
    }else if(scene){
      if(!SCENE_VALUES[aspect].includes(entry.value))throw fail('EVIDENCE_ANSWER_VOCABULARY');
      record.value=entry.value;
    }else if(aspect==='appearance'){record.color=picked(entry.color,COLORS);record.material=picked(entry.material,MATERIALS);}
    const mergeKey=evidenceKey(record),seen=merged.get(mergeKey);
    // Two values of one aspect (dusk in one clue, night in another): the first one stands.
    if(!seen){merged.set(mergeKey,{...record,clueIds:ids});continue;}
    seen.clueIds=[...new Set([...seen.clueIds,...ids])];seen.color=picked([...seen.color,...record.color],COLORS);seen.material=picked([...seen.material,...record.material],MATERIALS);
    if(record.textComplete)seen.textComplete=true;
  }
  const skipped=[];
  for(const entry of Array.isArray(parsed.skipped)?parsed.skipped:[]){
    if(!byId.has(entry?.clueId))throw fail('EVIDENCE_ANSWER_UNKNOWN_CLUE');
    if(!(entry.reason in SKIP_REASONS))throw fail('EVIDENCE_ANSWER_VOCABULARY');
    if(!skipped.some(seen=>seen.clueId===entry.clueId))skipped.push({clueId:entry.clueId,reason:entry.reason});
  }
  const order=id=>clues.findIndex(clue=>clue.id===id);
  const evidence=[...merged.values()].map((record,index)=>{
    const clueIds=record.clueIds.sort((a,b)=>order(a)-order(b)),sources=clueIds.map(id=>byId.get(id));
    const normalized=record.text?normalizeText(record.text):null;
    // Where it is in this photo: for text, the linked text regions that hold the string or part of
    // it; otherwise the object regions of the clues it came from.
    const regionIds=sources.flatMap(clue=>(clue.regions||[]).filter(region=>record.aspect==='text'
      ?region.kind==='text'&&[region.quoted,region.text].some(read=>{const found=normalizeText(read);return found&&(found.includes(normalized)||normalized.includes(found));})
      :record.aspect!=='logo'&&!(record.aspect in SCENE_VALUES)&&region.kind!=='text').map(region=>region.id));
    return {id:`ev-${index}`,key:evidenceKey(record),subject:record.subject,aspect:record.aspect,text:record.text,textComplete:record.textComplete,value:record.value,color:record.color,material:record.material,
      kinds:[...new Set(sources.map(clue=>clue.taxonomy?.number).filter(Number.isInteger))].sort((a,b)=>a-b),clueIds,regionIds:[...new Set(regionIds)]};
  });
  const accounted=new Set([...evidence.flatMap(record=>record.clueIds),...skipped.map(entry=>entry.clueId)]);
  if(clues.some(clue=>!accounted.has(clue.id)))throw fail('EVIDENCE_ANSWER_INCOMPLETE');
  return {evidence,skipped};
}

// llm: async ({model,reasoningEffort,text,attempt}) => {text,raw}. Returns the evidence records and
// the summary stored on the record as run.normalization.
export async function normalizeClues({clues,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{}}){
  const prompt=evidencePrompt(clues);
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const {text:answer,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'evidence',attempt,at:new Date().toISOString(),...raw,rawOutputText:answer});
    try{
      const result=parseEvidenceAnswer(answer,clues);
      return {evidence:result.evidence,summary:{version:EVIDENCE_VERSION,createdAt:new Date().toISOString(),model,promptSha256:createHash('sha256').update(prompt).digest('hex'),answer,attempts:attempt,skipped:result.skipped}};
    }catch(error){lastError=error;}
  }
  throw lastError;
}

// Whether two strings read from photos of one place are the same text. Equal after normalizeText, or
// the shorter is found inside the longer ("2277" / "869-2277", a name read without its first word),
// allowing for a misread letter: "메티스트" was read "매티스트" in the next photo. Letters are compared
// as Hangul jamo, so ㅔ/ㅐ is one difference in thirteen and not one syllable in six. No difference is
// allowed in a number (102 and 103 are two addresses), and a string under four units has to be equal.
const units=value=>[...normalizeText(value).normalize('NFD')];
export function sameText(a,b){
  const [short,long]=[units(a),units(b)].sort((x,y)=>x.length-y.length);
  if(!short.length)return false;
  if(short.join('')===long.join(''))return true;
  // The shorter also has to be at least two fifths of the longer: "수학" inside "진학 메티스트 수학" is
  // a common word, not that sign read in part.
  if(short.length<4||short.length<long.length*0.4)return false;
  const allowed=/^\p{N}+$/u.test(short.join(''))?0:Math.floor(short.length*0.15);
  // Fewest edits that turn `short` into some stretch of `long` (Sellers' approximate matching).
  let row=new Array(long.length+1).fill(0);
  for(let i=1;i<=short.length;i++){
    const next=[i];
    for(let j=1;j<=long.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+(short[i-1]===long[j-1]?0:1));
    row=next;
  }
  return Math.min(...row)<=allowed;
}
// The evidence of several records of one place, each clue once. records: [{runId,evidence}].
// Text and logo evidence are joined when sameText() holds; everything else when the keys are equal.
// Keys are computed again from the fields, so records normalized under an earlier key form still group.
// Returns {total, unique, groups:[{key, texts, members:[{runId,id}]}]}: `total` is what would be
// counted without this step, `unique` what should be. A text group is named after its longest reading.
export function groupEvidence(records){
  const items=records.flatMap(({runId,evidence})=>(evidence||[]).map(item=>({runId,item,key:evidenceKey(item),isText:item.aspect==='text'||item.aspect==='logo'})));
  const parent=items.map((_,index)=>index),find=index=>parent[index]===index?index:(parent[index]=find(parent[index]));
  for(let i=0;i<items.length;i++)for(let j=0;j<i;j++){
    const x=items[i],y=items[j];
    if(x.isText!==y.isText?false:x.isText?sameText(x.item.text,y.item.text):x.key===y.key)parent[find(i)]=find(j);
  }
  const groups=new Map();
  items.forEach((entry,index)=>{const root=find(index);groups.set(root,[...(groups.get(root)||[]),entry]);});
  return {total:items.length,unique:groups.size,groups:[...groups.values()].map(members=>{
    const texts=[...new Set(members.filter(entry=>entry.isText).map(entry=>entry.item.text))];
    const key=texts.length?`text|${texts.map(normalizeText).sort((a,b)=>b.length-a.length)[0]}`:members[0].key;
    return {key,texts,members:members.map(entry=>({runId:entry.runId,id:entry.item.id}))};
  })};
}

// ---------- The clues of one place, decided here so that whoever shows them does not have to ----------
// A place keeps the list of the clues its photos have shown. Each photo's evidence is matched against
// that list (the same rule as groupEvidence) and comes back with
//   placeClueId the id of the clue in the place's list: the key of its first sighting, never changed
//               afterwards, so the same clue read "메티스트수학" in one photo and "진학 매티스트 수학" in the
//               next carries one id;
//   seenBefore  true when an earlier photo of the place already showed that clue: it is not to be
//               counted again. The photo that showed it first keeps false, however often it is run again.
// place: {clues:[{clueId,key,isText,texts,runIds,risk}]} or null for a place with no photo yet. Returns
// the evidence with the two fields and the place to store. Evidence that matches two known clues takes
// the earlier one; clues already issued are never merged, because their ids are in use.
//
// Checking with the photos (added 2026-11-17). Evidence without text is matched by its kind alone, so
// a school and the shop across the lane came out as one `building|appearance`. That is right for a
// clue a whole city shares (a road-marking style seen twice is one clue) and wrong for one that
// narrows the place down. So when `riskOf` says the evidence, or the known clue, is medium or high,
// the kind is not enough: `verdicts` must say the photos show the same object. It holds what a model
// answered after looking at both photos (checkPrompt below), keyed `${evidence id}|${clueId}`.
// Anything but 'same' — different, unsure, never asked — makes it a clue of its own, `key#2`: counted
// once more rather than left out, since leaving out a clue that gives the place away is the worse error.
// Without `riskOf` nothing is checked.
const RISK_RANK={low:0,medium:1,high:2};
// What is about the whole photo (its language, season, viewpoint) is no object to compare: the kind decides.
const needsCheck=(risk,known)=>!(known.key??known.clueId).startsWith('scene|')&&Math.max(RISK_RANK[risk]??0,RISK_RANK[known.risk]??0)>=1;
const sameKind=(clues,key)=>clues.filter(known=>!known.isText&&(known.key??known.clueId)===key);
export function assignClues(place,runId,evidence,{riskOf=null,verdicts=new Map()}={}){
  const clues=(place?.clues||[]).map(clue=>({...clue,texts:[...clue.texts],runIds:[...clue.runIds]}));
  const assigned=evidence.map(item=>{
    const isText=item.aspect==='text'||item.aspect==='logo',key=evidenceKey(item),risk=riskOf?riskOf(item):null;
    let clue;
    if(isText)clue=clues.find(known=>known.isText&&known.texts.some(text=>sameText(text,item.text)));
    else{
      const candidates=sameKind(clues,key);
      // A photo run again keeps the clue it was given.
      clue=candidates.find(known=>known.runIds.includes(runId))??candidates.find(known=>!riskOf||!needsCheck(risk,known)||verdicts.get(`${item.id}|${known.clueId}`)==='same');
      if(!clue){clue={clueId:candidates.length?`${key}#${candidates.length+1}`:key,key,isText,texts:[],runIds:[]};clues.push(clue);}
    }
    if(!clue){clue={clueId:key,key,isText,texts:[],runIds:[]};clues.push(clue);}
    if(isText&&!clue.texts.includes(item.text))clue.texts.push(item.text);
    if(!clue.runIds.includes(runId))clue.runIds.push(runId);
    if((RISK_RANK[risk]??-1)>(RISK_RANK[clue.risk]??-1))clue.risk=risk;
    return {...item,placeClueId:clue.clueId,seenBefore:clue.runIds[0]!==runId};
  });
  return {evidence:assigned,place:{...place,clues}};
}
// The comparisons assignClues() would need a verdict for: [{evidenceId,clueId,refRunId}], where
// refRunId is the photo that showed the known clue first. Every known clue of the kind is listed, so
// one round of questions settles the photo.
export function pendingChecks(place,runId,evidence,riskOf){
  const clues=place?.clues||[];
  return evidence.flatMap(item=>{
    if(item.aspect==='text'||item.aspect==='logo')return [];
    const candidates=sameKind(clues,evidenceKey(item)),risk=riskOf(item);
    if(candidates.some(known=>known.runIds.includes(runId)))return [];
    return candidates.filter(known=>needsCheck(risk,known)).map(known=>({evidenceId:item.id,clueId:known.clueId,refRunId:known.runIds[0]}));
  });
}
// One question about two photos of the place, joined into one image: A on the left, B on the right.
// items: [{kind,inA,inB}], the clue texts the two records hold for the same kind of thing.
export const CHECK_VERDICTS=['same','different','unsure'];
export const checkPrompt=items=>`The image shows two photographs side by side: photo A on the left, photo B on the right. They were taken at the same position, possibly facing different ways. Do not name or guess the place.

For each item below, something described in photo A and something described in photo B were filed as the same kind of thing. Look at both photographs and decide whether they are the same physical object (the same building, the same gate, the same sculpture), seen in both.
- same: you can see it is the same object in both photographs
- different: they are two different objects
- unsure: the photographs do not let you tell (out of frame, too small, too dark)

Items:
${JSON.stringify(items.map((item,index)=>({item:index+1,kind:item.kind,inA:item.inA,inB:item.inB})),null,2)}

Answer with only this JSON, one entry per item:
\`\`\`json
{"1": "same", "2": "different"}
\`\`\`
`;
// -> one verdict per item, in order. An item left out or an unknown word is an error (the call is repeated).
export function parseCheckAnswer(answer,count){
  const raw=String(answer||''),fenced=[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(raw.match(/\{[\s\S]*\}/)||[])[0]]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed)throw fail('CHECK_ANSWER_INVALID');
  return Array.from({length:count},(_,index)=>{const verdict=parsed[String(index+1)];if(!CHECK_VERDICTS.includes(verdict))throw fail('CHECK_ANSWER_INCOMPLETE');return verdict;});
}
