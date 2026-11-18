// Paper-method pipeline: GeoMiner Detector -> ClueMiner analyzer (offline) -> ClueMiner classifier.
// Parsing and guard logic are ports of SaFo-Lab/DoxBench (Apache-2.0); see paper-prompts.mjs.
// `llm` is async ({model,text,imageBytes?}) => ({text,raw}); tests pass a fake.
import { DETECTOR_PROMPT,clueMinerPrompt,classifierPrompt,cotLocationPrompt } from './paper-prompts.mjs';

const stripComments=text=>text.trim().split('\n').filter(line=>!line.trim().startsWith('#')).join('\n').trim();
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,detail={})=>Object.assign(new Error(code),detail);

// ---------- 1. Detector: one image -> {category: detail} ----------

// Port of experiment.py extract_json_from_geominer_detector_answer(). The repository's second
// pattern is a strict subset of the first, so two patterns remain. Returns '' when nothing matches.
export function extractDetectorJson(answer){
  if(!answer)return '';
  const cleaned=answer.replace(/[​‌‍﻿]/g,'');
  const main=cleaned.match(/Json:\s*\n?\s*```json\s*([\s\S]*?)\s*```/i);
  if(main)return stripComments(main[1]);
  const loose=cleaned.match(/```[^`]*?(\{[\s\S]*?\})\s*```/i);
  if(loose){const body=loose[1].trim();if(body.startsWith('{')&&body.endsWith('}'))return body;}
  return '';
}
// The model's free category list from the first answer block. Kept for the record only.
export function parseCandidateCategories(answer){
  const block=(answer||'').match(/candidate_categories\s*=\s*\[([\s\S]*?)\]/);
  return block?[...block[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map(m=>m[1]??m[2]):[];
}
function detailOf(value){
  if(typeof value==='string')return {detail:value.trim(),valueType:'string'};
  if(Array.isArray(value)&&value.every(item=>typeof item==='string'))return {detail:value.map(item=>item.trim()).filter(Boolean).join('; '),valueType:'string_array'};
  return {detail:JSON.stringify(value),valueType:'structured'};
}
// One key/value pair is one clue. The repository forwards the JSON text untouched to the
// Analyzer; turning it into clue records is the only step added here.
export function parseDetectorAnswer(answer){
  const text=extractDetectorJson(answer);
  if(!text)throw fail('DETECTOR_JSON_MISSING');
  let parsed;try{parsed=JSON.parse(text);}catch{throw fail('DETECTOR_JSON_INVALID');}
  if(!isRecord(parsed))throw fail('DETECTOR_JSON_INVALID');
  const clues=Object.entries(parsed).map(([category,value])=>({category:category.trim(),...detailOf(value)})).filter(clue=>clue.category&&clue.detail).map((clue,index)=>({id:`clue-${index}`,...clue,taxonomy:null}));
  return {candidateCategories:parseCandidateCategories(answer),detectorJson:text,clues};
}
// A clue as one string: the Detector's detail often only makes sense next to its key.
export const clueText=clue=>`${clue.category}: ${clue.detail}`;

// Prompt first, image second, no system prompt, as in call_geominer_detector().
// prompt: the paper's by default. The analysis server gives a variant (paper-claude.mjs) when the
// model in use does not accept the paper's wording.
export async function extractClues({bytes,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{},prompt=DETECTOR_PROMPT}){
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,imageBytes:bytes,attempt});
    onCall({stage:'detector',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{return {...parseDetectorAnswer(text),answer:text,attempts:attempt};}catch(error){lastError=error;}
  }
  throw lastError;
}

// ---------- 2. ClueMiner analyzer: clue lists -> {category: definition} ----------

// Port of clueminer.py _parse_clue_list_pandas(): one image's clues as "- clue" lines.
export const entryText=clues=>clues.map(clue=>`- ${clueText(clue)}`).join('\n');

// Port of clueminer.py _parse_json_response(): whole text, then the outermost {...}.
// A fenced block after "Json:" is tried last; that fallback is not in the repository.
export function parseMemoryResponse(response){
  if(!response||!response.trim())return null;
  const whole=response.replace(/```json\s*/g,'').replace(/```\s*$/,'').trim();
  const attempts=[whole,(whole.match(/\{[\s\S]*\}/)||[])[0],extractDetectorJson(response)];
  for(const text of attempts){
    if(!text)continue;
    try{const parsed=JSON.parse(text);if(isRecord(parsed))return parsed;}catch{}
  }
  return null;
}
export const MAX_DELETED_CATEGORIES=8;
// The three guards in build_categories(): a rejected answer keeps the previous memory.
export function acceptMemory(memory,candidate){
  if(candidate===null)return {memory,skipped:true,reason:'JSON parsing failed'};
  if(!isRecord(candidate)||!Object.values(candidate).every(value=>typeof value==='string'))return {memory,skipped:true,reason:'Invalid response format'};
  const deleted=Object.keys(memory).length-Object.keys(candidate).length;
  if(deleted>MAX_DELETED_CATEGORIES)return {memory,skipped:true,reason:`Too many categories deleted: ${deleted}`};
  return {memory:candidate,skipped:false,reason:''};
}
// Python's dict(sorted(memory.items())): code point order, not locale order.
export const sortedMemory=memory=>Object.fromEntries(Object.keys(memory).sort().map(key=>[key,memory[key]]));
const sameMemory=(a,b)=>JSON.stringify(sortedMemory(a))===JSON.stringify(sortedMemory(b));

// Deterministic shuffle: the paper feeds the samples in random order.
export function shuffled(items,seed){
  let state=seed>>>0;
  const next=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  const out=[...items];
  for(let i=out.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
  return out;
}
// entries: [{key,text}] in the order to feed. state: {round,index,memory,roundStartMemory}, saved by
// the caller after every step so an interrupted run resumes at the same entry.
// The repository asks a person after each round; here a round that changes nothing ends the run.
export async function mineCategories({entries,state,maxRounds=5,model,reasoningEffort=null,llm,onStep=()=>{}}){
  const s={round:1,index:0,memory:{},roundStartMemory:{},...state};
  while(s.round<=maxRounds){
    for(;s.index<entries.length;){
      const entry=entries[s.index];const previousMemory=s.memory;
      const prompt=clueMinerPrompt([entry.text],previousMemory);
      const {text,raw}=await llm({model,reasoningEffort,text:prompt});
      const decision=acceptMemory(previousMemory,parseMemoryResponse(text));
      s.memory=decision.memory;s.index++;
      await onStep({round:s.round,entryIndex:s.index,entry,prompt,response:text,raw,previousMemory,memory:s.memory,skipped:decision.skipped,reason:decision.reason,state:{...s}});
    }
    if(sameMemory(s.roundStartMemory,s.memory))return {memory:sortedMemory(s.memory),rounds:s.round,converged:true};
    s.round++;s.index=0;s.roundStartMemory=s.memory;
    await onStep({roundFinished:s.round-1,state:{...s}});
  }
  return {memory:sortedMemory(s.memory),rounds:maxRounds,converged:false};
}
// final_categories.json order (alphabetical) with the numbers the classifier refers to.
export const numberTaxonomy=memory=>Object.entries(sortedMemory(memory)).map(([name,definition],index)=>({number:index+1,name,definition}));

// ---------- 3. ClueMiner classifier: each clue -> one category number ----------

export function parseClassifierAnswer(answer,clueCount,categoryCount){
  // The last fenced list wins; a bare "list: [..]" is accepted when the model drops the fence.
  let blocks=[...(answer||'').matchAll(/list:\s*```(?:python)?\s*(\[[\s\S]*?\])\s*```/gi)];
  if(!blocks.length)blocks=[...(answer||'').matchAll(/list:\s*(\[[^\]]*\])/gi)];
  if(!blocks.length)throw fail('CLASSIFIER_LIST_MISSING');
  const body=blocks.at(-1)[1].split('\n').map(line=>line.replace(/#.*$/,'')).join(' ').trim();
  if(!/^\[\s*(\d+\s*(,\s*\d+\s*)*)?,?\s*\]$/.test(body))throw fail('CLASSIFIER_LIST_INVALID');
  const numbers=(body.match(/\d+/g)||[]).map(Number);
  if(numbers.length!==clueCount)throw fail('CLASSIFIER_COUNT_MISMATCH');
  if(numbers.some(n=>n<1||n>categoryCount))throw fail('CLASSIFIER_NUMBER_OUT_OF_RANGE');
  return numbers;
}
// Returns the clues with taxonomy:{number,name} (plus group, when the taxonomy groups its categories).
// Throws when no attempt yields one valid number per clue.
export async function classifyClues({clues,categories,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{}}){
  if(!clues.length)return {clues:[],answer:null,attempts:0};
  const prompt=classifierPrompt(clues.map(clueText),categories);
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const {text,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'classifier',attempt,at:new Date().toISOString(),...raw,rawOutputText:text});
    try{
      const numbers=parseClassifierAnswer(text,clues.length,categories.length);
      const byNumber=new Map(categories.map(category=>[category.number,category]));
      return {clues:clues.map((clue,index)=>{const category=byNumber.get(numbers[index]);return {...clue,taxonomy:{number:category.number,name:category.name,...(category.group?{group:category.group}:{})}};}),answer:text,attempts:attempt};
    }catch(error){lastError=error;}
  }
  throw lastError;
}

// ---------- Evaluation only: address prediction with the paper's CoT prompt ----------
// This is the paper's main experiment ("where is it?"), kept apart from the product path, which
// does not infer locations. Its clue_list is what the paper fed to ClueMiner.

// Port of experiment.py extract_lists_from_answer(): the two fenced "list" blocks, as raw text.
export function extractLists(answer){
  const text=answer||'';
  const clue=text.match(/clue_list:\s*```list\s*(\[[\s\S]*?\])\s*```/i);
  const address=text.match(/address_list:\s*```list\s*(\[[\s\S]*?\])\s*```/i);
  return {clueListRaw:clue?clue[1]:'',addressListRaw:address?address[1]:''};
}
// The repository keeps the raw text. It is parsed here only when it is a JSON list of strings;
// anything else (an echoed placeholder, single quotes) stays raw and yields null.
export function parseStringList(raw){
  if(!raw)return null;
  try{const value=JSON.parse(raw);return Array.isArray(value)&&value.every(item=>typeof item==='string')?value.map(item=>item.trim()).filter(Boolean):null;}catch{return null;}
}
// One call, no retry, as in the repository: an answer without an address list is a result
// (the paper counts it against the valid-response rate), not an error.
export async function predictLocation({bytes,model,reasoningEffort=null,llm,topN=1,onCall=()=>{}}){
  const {text,raw}=await llm({model,reasoningEffort,text:cotLocationPrompt(topN),imageBytes:bytes,attempt:1});
  onCall({stage:'locator',attempt:1,at:new Date().toISOString(),...raw,rawOutputText:text});
  const lists=extractLists(text);
  return {answer:text,topN,...lists,clueList:parseStringList(lists.clueListRaw),addressList:parseStringList(lists.addressListRaw)};
}
