// Region linking for paper-method clues. NOT part of the paper: the Detector returns text only and
// the paper never locates a clue in the image. This step is added because the product has to show
// where a clue is. Coordinates come from tools only (PaddleOCR polygons, Grounding DINO boxes); no
// model is asked for coordinates, and nothing here verifies that a box really shows the clue.
//   written text  -> strings the clue quotes are matched against OCR lines (no model involved)
//   visible things -> a text-only model step turns each clue into detector phrases, DINO finds boxes
import { createHash } from 'node:crypto';

export const REGION_VERSION='paper-regions-v1';
// Written for this project, not taken from the paper. The model sees the clue text, not the photo.
export const REGION_TARGET_TEMPLATE=`You prepare search phrases for an object detector. Below are clues that were written about one photograph. You do not see the photograph.

For each clue, list the physical things that the clue text says are visible, as short English noun phrases the detector can look for.

Rules:
- 2 to 6 words per phrase, lowercase, one kind of thing per phrase (for example "red fire extinguisher", "storefront awning sign", "metal drainage grate").
- Use only things the clue text itself describes as visible. Add nothing the text does not mention.
- If a clue mentions several different things, give several phrases, at most 4 per clue.
- Leave out written text, names and quoted strings. Written text is located separately; you may still name the object that carries it (for example "menu poster").
- Give an empty list for a clue that names no single visible thing: season, weather, language, culture, style, framing, or an overall impression.

Clues:
<<CLUES>>

Answer with only this JSON. Every clue id must appear exactly once as a key.
\`\`\`json
{"clue-0": ["phrase", "phrase"], "clue-1": []}
\`\`\`
`;
export const regionTargetPrompt=clues=>REGION_TARGET_TEMPLATE.replace('<<CLUES>>',()=>JSON.stringify(clues.map(({id,category,detail})=>({id,category,detail})),null,2));
export const MAX_PHRASES_PER_CLUE=4;

const fail=code=>new Error(code);
// Strings the Detector put in quotes are its transcriptions of text seen in the photo.
export function quotedStrings(detail){
  // Double quotes, curly quotes, and single quotes that are not apostrophes inside a word.
  const found=[...String(detail).matchAll(/"([^"\n]{2,120})"|“([^”\n]{2,120})”|(?<![\p{L}\p{N}])'([^'\n]{2,120})'(?![\p{L}\p{N}])/gu)].map(m=>(m[1]??m[2]??m[3]).trim()).filter(Boolean);
  return [...new Set(found)];
}
const normalize=text=>String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
function distance(a,b){
  let previous=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    const current=[i];
    for(let j=1;j<=b.length;j++)current[j]=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));
    previous=current;
  }
  return previous[b.length];
}
// How a quoted string and one OCR line correspond, or null. OCR often splits a phrase over several
// lines or merges neighbours into one, so containment in either direction counts.
export function matchText(target,lineText){
  const t=normalize(target),l=normalize(lineText);
  if(!t||!l)return null;
  if(t===l)return 'exact';
  const shorter=t.length<l.length?t:l,longer=t.length<l.length?l:t;
  // Two characters are enough for scripts without spaces between syllables; three for Latin text.
  const longEnough=shorter.length>=3||(shorter.length===2&&/[^\x00-\x7f]/.test(shorter));
  if(longEnough&&longer.includes(shorter))return shorter===l?'line_in_quote':'quote_in_line';
  if(Math.min(t.length,l.length)>=5&&1-distance(t,l)/Math.max(t.length,l.length)>=0.85)return 'fuzzy';
  // A misread part (added 2026-11-16): OCR read "MAPO KANGANG" where the clue quotes "MAPO HANGANG
  // PRUGIO" — one wrong letter and a missing word, so neither containment nor the whole-string
  // comparison above saw it, and a clue confirmed by the map search had no box. The shorter string
  // is slid along the longer one; a stretch of the same length that differs in at most 15% of its
  // characters counts. Six characters at least (Latin) so that short words do not match by chance;
  // three for scripts without spaces.
  const enough=/[^\x00-\x7f]/.test(shorter)?3:6;
  if(shorter.length>=enough){
    const allowed=Math.floor(shorter.length*0.15);
    if(allowed>=1)for(let start=0;start+shorter.length<=longer.length;start++)if(distance(shorter,longer.slice(start,start+shorter.length))<=allowed)return shorter===l?'line_near_quote_part':'quote_near_line_part';
  }
  // One or two wrong syllables (added 2026-11-16): OCR read "화교법인일송회원" where the clue quotes
  // "학교법인 일송학원". Hangul OCR errors are mostly a syllable with one wrong letter (학→화, 송→종),
  // which the 15% rule above does not allow twice in eight syllables. For Hangul, 4-6 syllables may
  // differ in one, 7 or more in two, and the letters (jamo) of the aligned stretch must still agree in
  // at least 70%, so that a syllable is replaced by a similar one rather than by anything.
  if(/[가-힣]/.test(shorter)&&shorter.length>=4){
    const allowed=shorter.length>=7?2:1,jamo=text=>text.normalize('NFD');
    // Whole strings first: a dropped syllable ("학교인일송회원") changes the length.
    if(distance(t,l)<=allowed){const a=jamo(t),b=jamo(l);if(1-distance(a,b)/Math.max(a.length,b.length)>=0.7)return 'fuzzy_syllables';}
    for(let start=0;start+shorter.length<=longer.length;start++){
      const stretch=longer.slice(start,start+shorter.length);
      if(distance(shorter,stretch)>allowed)continue;
      const a=jamo(shorter),b=jamo(stretch);
      if(1-distance(a,b)/Math.max(a.length,b.length)>=0.7)return shorter===l?'line_near_quote_syllables':'quote_near_line_syllables';
    }
  }
  return null;
}
export function boundsOf(polygon){
  const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}
// The model's answer: {clueId: [phrase, ...]}. Unknown ids are an error; a missing id means no phrases.
export function parseTargets(answer,clueIds){
  const text=String(answer||'');
  const fenced=[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(m=>m[1]).at(-1);
  const candidates=[fenced,(text.match(/\{[\s\S]*\}/)||[])[0],text.trim()];
  let parsed=null;
  for(const candidate of candidates){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed)throw fail('REGION_TARGETS_INVALID');
  const known=new Set(clueIds);
  if(Object.keys(parsed).some(key=>!known.has(key)))throw fail('REGION_TARGETS_UNKNOWN_CLUE');
  return Object.fromEntries(clueIds.map(id=>{
    const value=parsed[id]??[];
    if(!Array.isArray(value)||value.some(phrase=>typeof phrase!=='string'))throw fail('REGION_TARGETS_INVALID');
    const phrases=[...new Set(value.map(phrase=>phrase.trim().toLowerCase().replace(/\.+$/,'')).filter(phrase=>phrase.length>=3&&phrase.length<=80))];
    return [id,phrases.slice(0,MAX_PHRASES_PER_CLUE)];
  }));
}

// ocr: async bytes => {engine,version,lines:[{id,text,score,polygon}]}  (adapters.realAdapters.ocr)
// detect: async (bytes,[{cueId,query}]) => {engine,model,revision,requests:[{cueId,query,detections}]}
// Returns the clues with textTargets, objectTargets, regions and localization added.
// policy (paper-risk-tiers.mjs TIERED_POLICY), with tierOf(clue): look only where a clue could matter.
// A clue outside objectTiers gets no detector phrases, one outside textTiers no OCR matching, and no
// clue more than maxPhrasesPerClue phrases. Such a clue is marked not_searched, which is different
// from searched and not found (unlocalized). Without a policy every clue is searched, as before.
// The model is still asked about every clue: the request is the same either way, so answers already
// given are reused, and the filter is applied to what comes back.
export async function linkRegions({bytes,clues,model,reasoningEffort=null,llm,ocr,detect,maxPerPhrase=3,maxBoxArea=0.8,attempts=2,policy=null,tierOf=()=>null,onCall=()=>{}}){
  // 1. Detector phrases, from the clue text only. Done first: with the file hand-off this is where
  //    the run may have to wait, before any slow tool has started.
  const prompt=regionTargetPrompt(clues);
  let targets=null,answer=null,lastError;
  for(let attempt=1;attempt<=attempts&&!targets;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'regionTargets',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{targets=parseTargets(text,clues.map(clue=>clue.id));answer=text;}catch(error){lastError=error;}
  }
  if(!targets)throw lastError;

  // 2. Written text: quoted strings against OCR lines.
  const ocrResult=await ocr(bytes);
  const linked=clues.map(clue=>{
    const tier=policy?tierOf(clue):null,searchText=!policy||policy.textTiers.includes(tier),searchObjects=!policy||policy.objectTiers.includes(tier)||Boolean(policy.objectCategories?.includes(clue.taxonomy?.name));
    const textTargets=searchText?quotedStrings(clue.detail):[];
    // policy.skipObjectsForQuotedText: a clue that quotes text is located by its OCR line only (paper-risk.mjs
    // trustedRegions), so the detector is not asked about it at all.
    const objectTargets=searchObjects&&!(policy?.skipObjectsForQuotedText&&textTargets.length)?targets[clue.id].slice(0,policy?.maxPhrasesPerClue??MAX_PHRASES_PER_CLUE):[];
    return {...clue,...(policy?{risk:{tier,tierVersion:policy.tierVersion}}:{}),textTargets,objectTargets,regions:[],searched:{text:searchText,objects:searchObjects}};
  });
  const usedLines=new Set();
  for(const clue of linked)for(const line of ocrResult.lines){
    const hit=clue.textTargets.map(target=>({target,match:matchText(target,line.text)})).find(candidate=>candidate.match);
    if(!hit)continue;
    usedLines.add(line.id);
    clue.regions.push({id:`${clue.id}-ocr-${line.id}`,source:'paddleocr',kind:'text',bbox:boundsOf(line.polygon),polygon:line.polygon,text:line.text,quoted:hit.target,match:hit.match,score:line.score});
  }

  // 3. Visible things: one detector query per distinct phrase, mapped back to every clue that asked for it.
  const phrases=[...new Set(linked.flatMap(clue=>clue.objectTargets))];
  let detection={engine:null,model:null,revision:null,requests:[]},droppedLargeBoxes=0;
  for(let start=0;start<phrases.length;start+=80){
    const batch=phrases.slice(start,start+80).map((query,index)=>({cueId:`q-${start+index}`,query}));
    const result=await detect(bytes,batch);
    detection={engine:result.engine,model:result.model,revision:result.revision,requests:[...detection.requests,...result.requests]};
  }
  const byPhrase=new Map(detection.requests.map(request=>[request.query,[...request.detections].sort((a,b)=>b.score-a.score)]));
  for(const clue of linked)clue.objectTargets.forEach((phrase,phraseIndex)=>{
    const boxes=(byPhrase.get(phrase)||[]).filter(box=>{const tooLarge=(box.bbox[2]-box.bbox[0])*(box.bbox[3]-box.bbox[1])>maxBoxArea;if(tooLarge)droppedLargeBoxes++;return !tooLarge;});
    boxes.slice(0,maxPerPhrase).forEach((box,rank)=>clue.regions.push({id:`${clue.id}-dino-${phraseIndex}-${rank}`,source:'grounding_dino',kind:'object',bbox:box.bbox,query:phrase,label:box.label,score:box.score}));
  });
  for(const clue of linked){
    // not_searched: the policy held something back and nothing was looked for. A clue the policy
    // left alone that simply has nothing to look for stays unlocalized, as without a policy.
    const lookedFor=clue.textTargets.length||clue.objectTargets.length,heldBack=!clue.searched.text||!clue.searched.objects;
    clue.localization=clue.regions.length?'proposed':heldBack&&!lookedFor?'not_searched':'unlocalized';
    delete clue.searched;
  }

  return {clues:linked,summary:{version:REGION_VERSION,createdAt:new Date().toISOString(),verification:'none',policy:policy??{name:'all'},
    targets:{model,promptSha256:createHash('sha256').update(prompt).digest('hex'),answer},
    ocr:{engine:ocrResult.engine,version:ocrResult.version,lineCount:ocrResult.lines.length,linkedLineCount:usedLines.size,lines:ocrResult.lines.map(({id,text,score,polygon})=>({id,text,score,polygon,linked:usedLines.has(id)}))},
    detection:{engine:detection.engine,model:detection.model,revision:detection.revision,queryCount:phrases.length,maxPerPhrase,maxBoxArea,droppedLargeBoxes}}};
}

// A quoted string is taken to be text seen in the photo (quotedStrings). A model also puts in quotes
// a name it recognised: a plush toy "matching 'Puang', the mascot of ..." carries no such text. Such
// a clue was treated as written text, so the detector was never asked about the toy, OCR found
// nothing, and the clue ended without a region although the toy fills a corner of the photo
// (seen 2026-11-17). After the text recheck (paper-text-recheck.mjs), a clue whose quoted strings were
// found neither by OCR nor by the model that looked for them has no text in the photo: the strings
// are moved to clue.unreadQuotes, the clue counts as an object clue again, and the detector is asked
// for the phrases the model gave for it in the region-target answer.
// Changes `clues` in place. Returns {clues:[ids],queryCount,located,droppedLargeBoxes}.
export const quotesNotInPhoto=clue=>(clue.textTargets||[]).length>0&&!(clue.regions||[]).some(region=>region.kind==='text');
export async function relinkUnreadQuotes({bytes,clues,targetsAnswer,detect,maxPerPhrase=3,maxBoxArea=0.8,policy=null,tierOf=()=>null}){
  const affected=clues.filter(quotesNotInPhoto),summary={clues:affected.map(clue=>clue.id),queryCount:0,located:0,droppedLargeBoxes:0};
  if(!affected.length)return summary;
  let targets={};
  try{targets=parseTargets(targetsAnswer,clues.map(clue=>clue.id));}catch{}
  for(const clue of affected){
    const searchObjects=!policy||policy.objectTiers.includes(tierOf(clue))||Boolean(policy.objectCategories?.includes(clue.taxonomy?.name));
    clue.unreadQuotes=clue.textTargets;clue.textTargets=[];
    clue.objectTargets=searchObjects?(targets[clue.id]||[]).slice(0,policy?.maxPhrasesPerClue??MAX_PHRASES_PER_CLUE):[];
    clue.regions??=[];
  }
  const phrases=[...new Set(affected.flatMap(clue=>clue.objectTargets))];
  summary.queryCount=phrases.length;
  if(!phrases.length)return summary;
  const result=await detect(bytes,phrases.map((query,index)=>({cueId:`u-${index}`,query})));
  const byPhrase=new Map(result.requests.map(request=>[request.query,[...request.detections].sort((a,b)=>b.score-a.score)]));
  for(const clue of affected){
    clue.objectTargets.forEach((phrase,phraseIndex)=>{
      const boxes=(byPhrase.get(phrase)||[]).filter(box=>{const tooLarge=(box.bbox[2]-box.bbox[0])*(box.bbox[3]-box.bbox[1])>maxBoxArea;if(tooLarge)summary.droppedLargeBoxes++;return !tooLarge;});
      boxes.slice(0,maxPerPhrase).forEach((box,rank)=>clue.regions.push({id:`${clue.id}-dino-${phraseIndex}-${rank}`,source:'grounding_dino',kind:'object',bbox:box.bbox,query:phrase,label:box.label,score:box.score}));
    });
    if(clue.regions.length){clue.localization='proposed';summary.located++;}
  }
  return summary;
}
