// Risk judgement by the owner's rule sheet ("꼭꼭 규칙", 2026-11-17). NOT part of the paper.
// The sheet replaces the category tiers (paper-risk-tiers.mjs) as what a clue's risk is:
//   a clue's risk follows the unit it narrows the place down to, judged per clue from its evidence;
//   the class only says what kind of clue it is, and the same class holds several units.
//   Clues are judged alone (chapters 1-2); what they give away together is judged apart (chapter 3).
// The judgement needs reading each clue ("is the whole name legible", "is this a nationwide chain"),
// so a model does it, from the clue text only: it does not see the photo and is told not to name a
// place. The model answers with a class and a unit; the risk is derived here from the unit, and the
// sheet's fixed rules (a regional-style clue is always low, a combination must be narrower than its
// narrowest member) are enforced here, not left to the model.
import { createHash } from 'node:crypto';
import { clueTier } from './paper-risk-tiers.mjs';
import { riskLabels } from './paper-risk.mjs';
import { guessUsedClues,guessSoloResult } from './paper-guess.mjs';

export const RULE_VERSION='kkokkkok-rules-2026-11-17';
// Chapter 1. Ordered from narrow to wide.
export const RULE_UNITS={point:{ko:'지점 하나',risk:'high'},few:{ko:'몇 곳 / 동네',risk:'medium'},city:{ko:'도시·구',risk:'low'},country:{ko:'국가·광역',risk:'low'}};
// Class, unit and risk are given as their codes only: whoever shows them picks the wording
// (RULE_CLASSES and RULE_UNITS hold the sheet's Korean names).// Chapter 2, sections 2-1 to 2-7.
export const RULE_CLASSES={identifier:'고유 식별자',structure:'독특한 구조물',chain:'체인·반복 브랜드',view:'조망·주변 맥락',regional:'지역 공통 양식',nature:'자연환경',other:'기타'};
const UNIT_ORDER=Object.keys(RULE_UNITS),rank=unit=>UNIT_ORDER.indexOf(unit);
export const COMBINATION_TYPE=/^(A[1-8]|B[1-4]|C[1-3]|D[12])$/;

// The sheet's tables, in its own words. C1-C3: the PDF's table is shifted by a row; read as
// C1 몇 곳, C2 몇 곳, C3 지점 하나, which is also what 3-4 says (three low clues can make a point).
export const RULE_TEMPLATE=`You judge how far each clue narrows down where a photograph was taken. Below are clues that were written about one photograph. You do not see the photograph. Never name or guess the actual place: judge only how many places a clue fits.

## 1. Units
- point: narrows to one spot (one building, one shop, one specific place)
- few: a few candidate places, or one neighbourhood
- city: many places within one city or district fit
- country: a whole country or wide region fits

Common rules:
- If the evidence is ambiguous, choose the next wider unit.
- Judge each clue by itself. What clues give away together is judged separately in section 3.
- A clue's class only says what kind of clue it is. Within one class the unit depends on the evidence.

## 2. Classes (세부 상황 | 판정 근거 → unit)
identifier (고유 식별자)
- 비체인 상호 전체가 읽힘 (흔하지 않은 이름) | 상호 전체가 판독되고 체인 표시가 없음 → point
- 건물명, 아파트 단지명 + 동 번호 | 이름과 번호가 함께 읽힘 → point
- 주소판, 번지판, 도로명판 + 번호 | 도로명과 번호가 함께 읽힘 → point
- 지하철역명, 정류장명 | 역·정류장 이름이 읽힘 → point
- 학교, 교회, 병원 등 기관명 (흔하지 않은 이름) | 이름 전체가 읽힘 → point
- 흔한 이름의 상호·기관 (예: "행복슈퍼", "중앙교회") | 이름은 읽히지만 같은 이름이 많을 것으로 보임 → few
- 고유명이 일부만 읽힘 | 글자 일부가 가려지거나 흐림 → few
- 도로명판만 있고 번호는 없음 | 도로명만 읽힘 → few
- 단지명 없는 아파트 동 번호 | "103동"처럼 번호만 보임 → city
- 버스 노선 번호만 보임 | 정류장명 없이 노선 번호만 보임 → city

structure (독특한 구조물)
- 널리 알려진 랜드마크가 가까이 보임 | 형태만으로 알아볼 수 있는 구조물 → point
- 유일해 보이는 벽화, 조형물, 설치물 | 같은 것이 여러 곳에 있을 가능성이 낮음 → point
- 특징적이지만 비슷한 것이 있을 수 있는 외관 | 특이한 외벽 색, 아치형 입구, 독특한 창 배열 → few
- 표준 설계로 반복되는 구조물 | 같은 브랜드 아파트 외관, 표준형 육교·정류장 → city

chain (체인·반복 브랜드)
- 지점명이 함께 읽힘 (예: "○○점") | 브랜드와 지점명이 함께 판독됨 → point
- 매장 수가 적은 브랜드 (지역 체인, 소규모 프랜차이즈) | 흔하지 않은 브랜드로 보임 → few
- 전국 규모 브랜드만 보임 | 편의점, 대형 카페, 은행 등 → city
- 공공기관·교통 운영사 로고 | 지역 단위로 쓰이는 로고 → city or country

view (조망·주변 맥락)
- 랜드마크가 크게, 특정 각도로 보이고 앞쪽 건물 배치도 보임 | 크기, 각도, 앞쪽 배치가 함께 보임 → few
- 특징적인 산·강·해안선 윤곽 | 윤곽이 뚜렷하고 독특함 → few
- 멀리 작게 보이는 랜드마크 하나 | 넓은 지역에서 보이는 대상 → city
- 특징 없는 스카이라인, 일반 산 능선 | 구별할 만한 요소가 없음 → city
- 높은 층 시점만 보임 | 높이만 알 수 있음 → city

regional (지역 공통 양식) — always country
- 언어·문자, 도로 표시, 표지판 양식, 번호판 형식, 전신주·맨홀 양식, 지역 건축 양식 | 국가나 넓은 지역이 공유함 → country

nature (자연환경)
- 매우 특이한 지형 (독특한 바위, 특이한 해안 형태) | 형태가 드물고 뚜렷함 → few
- 특정 기후의 식생, 일반 지형 | 넓은 지역에 분포함 → country

other (기타) — a clue that fits none of the classes above. Apply the four units of section 1 directly.

## 3. Combinations
List a combination only when ALL of these hold:
1. Every member is a clue in the list below.
2. Together they narrow to a unit clearly narrower than the narrowest member alone.
3. You can say why seeing them together matters (a spatial relation, or the overlap of two sets of places).

Types (members → combined unit):
A. Overlap of the sets of places each clue points to
- A1 전국 체인 2개가 함께 보임 → few
- A2 전국 체인 3개 이상이 함께 보임 → point
- A3 체인 + 흔한 이름의 고유 상호 → point
- A4 체인 + 일부만 읽힌 고유명 → point
- A5 체인 + 버스 노선 번호 → few
- A6 버스 노선 번호 2개 이상 → few (point when three or more routes)
- A7 도로명(번호 없음) + 체인 → point
- A8 소규모 체인 + 특징적 외관 → point
B. Spatial layout: the relative position of clues narrows where the camera stood
- B1 멀리 보이는 랜드마크 2개 이상의 각도·거리 → point
- B2 멀리 보이는 랜드마크 + 앞쪽 특징적 건물 → point
- B3 멀리 보이는 랜드마크 + 높은 층 시점 → few
- B4 특징적 산·강 윤곽 + 앞쪽 건물 배치 → point
C. View plus surroundings: what is seen through a window or around narrows the position
- C1 창밖 전국 체인 간판 + 특징 없는 스카이라인 → few
- C2 창밖 체인 간판 + 높은 층 시점 → few
- C3 창밖 체인 간판 2개 이상 + 높은 층 시점 → point
D. Nature plus man-made
- D1 특이한 지형 + 특징적 건물 → point
- D2 특이한 지형 + 전국 체인 → point
Use type "other" for a combination that meets the three conditions but matches no row.

Do NOT list a combination when:
- a member is already "point" (nothing is left to narrow);
- a member is of class regional (the other clue already assumes that region);
- the members describe the same object (a sign's text and the same sign's logo);
- the members are wide and unrelated, so together they are still city level (예: 단지명 없는 동 번호 + 표준형 아파트 외관, 일반 식생 + 체인);
- no spatial relation can be stated (two chains in unrelated parts of the photo).

Clues:
<<CLUES>>

Answer with only this JSON. Every clue id must appear exactly once under "clues". "situation" is the row of section 2 that fits, in the Korean wording above (your own short Korean wording for class other). "basis" is one Korean sentence saying what in the clue decided the unit. "reason" is one Korean sentence saying why the members matter together. "combinations" may be empty.
\`\`\`json
{"clues": {"clue-0": {"class": "identifier", "situation": "지하철역명, 정류장명", "basis": "역 이름이 읽힘", "unit": "point"}},
 "combinations": [{"type": "A1", "clueIds": ["clue-1", "clue-2"], "unit": "few", "reason": "편의점과 맞은편 카페 체인이 한 장면에 보임"}]}
\`\`\`
`;
export const rulePrompt=clues=>RULE_TEMPLATE.replace('<<CLUES>>',()=>JSON.stringify(clues.map(({id,category,detail})=>({id,category,detail})),null,2));

const fail=code=>new Error(code);
const text=value=>typeof value==='string'?value.trim().slice(0,300):'';
const judgement=(cls,unit,situation,basis)=>({class:cls,situation,basis,unit,risk:RULE_UNITS[unit].risk});
// The model's answer. A malformed answer or a clue without a valid judgement is an error (the call is
// repeated). A combination that breaks the sheet's conditions is not: it is left out and counted.
// Returns {clues:{id:judgement}, combinations:[...], rejected:[{type,clueIds,code}]}.
export function parseRuleAnswer(answer,clueIds){
  const raw=String(answer||'');
  const fenced=[...raw.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match=>match[1]).at(-1);
  let parsed=null;
  for(const candidate of [fenced,(raw.match(/\{[\s\S]*\}/)||[])[0],raw.trim()]){if(!candidate)continue;try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value)){parsed=value;break;}}catch{}}
  if(!parsed||!parsed.clues||typeof parsed.clues!=='object'||Array.isArray(parsed.clues))throw fail('RULE_ANSWER_INVALID');
  const known=new Set(clueIds);
  if(Object.keys(parsed.clues).some(id=>!known.has(id)))throw fail('RULE_ANSWER_UNKNOWN_CLUE');
  const clues={};
  for(const id of clueIds){
    const entry=parsed.clues[id];
    if(!entry||!(entry.class in RULE_CLASSES)||!(entry.unit in RULE_UNITS)||!text(entry.basis))throw fail('RULE_ANSWER_INCOMPLETE');
    // 2-5: a regional-style clue is always low, whatever unit the model gave.
    clues[id]=judgement(entry.class,entry.class==='regional'?'country':entry.unit,text(entry.situation),text(entry.basis));
  }
  const combinations=[],rejected=[];
  for(const entry of Array.isArray(parsed.combinations)?parsed.combinations:[]){
    const ids=[...new Set(Array.isArray(entry?.clueIds)?entry.clueIds.filter(id=>typeof id==='string'):[])],type=COMBINATION_TYPE.test(entry?.type)?entry.type:'other';
    const reject=code=>rejected.push({type,clueIds:ids,code});
    if(ids.length<2||ids.some(id=>!known.has(id))){reject('MEMBERS_INVALID');continue;}
    if(!(entry.unit in RULE_UNITS)||!text(entry.reason)){reject('INCOMPLETE');continue;}
    // 3-3: nothing is left to narrow below a point; a regional-style clue is the others' premise.
    if(ids.some(id=>clues[id].unit==='point')){reject('MEMBER_ALREADY_POINT');continue;}
    if(ids.some(id=>clues[id].class==='regional')){reject('MEMBER_REGIONAL');continue;}
    // 3-1 condition 2: clearly narrower than the narrowest member.
    if(rank(entry.unit)>=Math.min(...ids.map(id=>rank(clues[id].unit)))){reject('NOT_NARROWER');continue;}
    combinations.push({id:`combo-${combinations.length}`,type,clueIds:ids,unit:entry.unit,risk:RULE_UNITS[entry.unit].risk,reason:text(entry.reason)});
  }
  return {clues,combinations,rejected};
}

// llm: async ({model,reasoningEffort,text,attempt}) => {text,raw}. Returns the clues with `rule` added
// and the summary stored on the record as run.rules.
export async function judgeClues({clues,model,reasoningEffort=null,llm,attempts=2,onCall=()=>{}}){
  const prompt=rulePrompt(clues),ids=clues.map(clue=>clue.id);
  let lastError;
  for(let attempt=1;attempt<=attempts;attempt++){
    const {text:answer,raw}=await llm({model,reasoningEffort,text:prompt,attempt});
    onCall({stage:'rules',attempt,at:new Date().toISOString(),...raw,rawOutputText:answer});
    try{
      const result=parseRuleAnswer(answer,ids);
      return {clues:clues.map(clue=>({...clue,rule:result.clues[clue.id]})),
        summary:{version:RULE_VERSION,createdAt:new Date().toISOString(),verification:'none',model,promptSha256:createHash('sha256').update(prompt).digest('hex'),answer,attempts:attempt,combinations:result.combinations,rejectedCombinations:result.rejected}};
    }catch(error){lastError=error;}
  }
  throw lastError;
}

// The judgement of one clue for display. A clue not judged yet falls back to its category's old tier
// (A: point, B: city, C: country), marked judged:false: the category default, not the sheet's
// per-clue reading. An unclassified clue counts as a point: unknown is not the same as harmless.
const FALLBACK_UNIT={A:'point',B:'city',C:'country'};
export function ruleOf(clue){
  if(clue.rule&&clue.rule.unit in RULE_UNITS)return {...judgement(clue.rule.class,clue.rule.unit,clue.rule.situation??'',clue.rule.basis??''),judged:true};
  return {...judgement(null,FALLBACK_UNIT[clueTier(clue)??'A'],'','범주 기본값입니다. 규칙에 따른 단서별 판정을 아직 하지 않았습니다.'),judged:false};
}
// The combination an address guess that found the place was made from (paper-guess.mjs; evaluation
// records only, added 2026-11-17). Not judged by the sheet but measured: the guess landed on the place,
// so its unit is a point and its risk high. Clues whose own unit is country (a regional style, the
// climate's plants) are left out: every photo of the country shows them, so covering them hides
// nothing, and the sheet already treats them as the others' premise.
// Which of the rest count (changed 2026-11-18, owner's decision): the guess lists everything it looked
// at, and a museum's name finds the museum without the trees beside it. So each clue is asked whether
// it gives the place away by itself, and there can be several such clues in one photo:
//   rule    the sheet already reads it as a point (a full, uncommon name; a station; a landmark)
//   search  a map search of its text led to the true place (paper-risk.mjs `confirmed`)
//   alone   tried alone, it led to the place the guess found (paper-guess.mjs testGuessSolo)
// mode 'solo'      some clue does: the combination is those clues (`clueIds`), each a risk by itself,
//                  and the others the guess named are `supporting`: they keep their own risk.
// mode 'combined'  every clue was tried and none does: the place came from them together, so all of
//                  them are the combination.
// mode 'untested'  the clues were not tried alone yet and none is a point by the sheet or a search:
//                  all are listed, and none is raised until the test says which case this is.
// Null when the guess missed, was not matched yet, or nothing coverable is left.
export const GUESS_COMBINATION_ID='guess';
const GUESS_REASON={solo:'주소 추정이 실제 위치를 맞혔고, 이 단서는 각각 혼자서도 그 위치가 나옵니다.',
  combined:'주소 추정이 실제 위치를 맞혔고, 어느 단서도 혼자서는 위치가 나오지 않아 함께 쓰인 단서들입니다.',
  untested:'주소 추정이 실제 위치를 맞혔고, 추정 근거로 이 단서들을 들었습니다. 단서별 단독 시험은 아직 하지 않았습니다.'};
// The coverable clues the hit guess used: [clue]. Internal to the two functions below.
function guessMembers(run){
  const used=guessUsedClues(run);
  if(!used)return null;
  const byId=new Map(run.clues.map(clue=>[clue.id,clue])),all=used.clueIds.map(id=>byId.get(id));
  return {members:all.filter(clue=>ruleOf(clue).unit!=='country'),excluded:all.filter(clue=>ruleOf(clue).unit==='country').map(clue=>clue.id)};
}
// The members still to be tried alone: not a point by the sheet, not confirmed by a search.
export function guessSoloTargets(run){
  const found=guessMembers(run);
  if(!found)return [];
  const marks=riskLabels(run).clues;
  return found.members.filter(clue=>ruleOf(clue).risk!=='high'&&marks[clue.id].label!=='confirmed');
}
export function guessCombination(run){
  const found=guessMembers(run);
  if(!found?.members.length)return null;
  const marks=riskLabels(run).clues,tested=guessSoloResult(run),alone=new Set((tested?.clues||[]).filter(entry=>entry.hit).map(entry=>entry.clueId));
  const soloBy={};
  for(const clue of found.members){
    const by=ruleOf(clue).risk==='high'?'rule':marks[clue.id].label==='confirmed'?'search':alone.has(clue.id)?'alone':null;
    if(by)soloBy[clue.id]=by;
  }
  const ids=found.members.map(clue=>clue.id),solo=ids.filter(id=>soloBy[id]);
  // Every member that needed the test has an answer: only then is "none does it alone" known.
  const answered=new Set((tested?.clues||[]).map(entry=>entry.clueId)),complete=Boolean(tested)&&guessSoloTargets(run).every(clue=>answered.has(clue.id));
  const mode=solo.length?'solo':complete?'combined':'untested';
  return {id:GUESS_COMBINATION_ID,type:'guess',source:'address_guess',mode,clueIds:mode==='solo'?solo:ids,supporting:mode==='solo'?ids.filter(id=>!soloBy[id]):[],soloBy,
    unit:'point',risk:RULE_UNITS.point.risk,reason:GUESS_REASON[mode],excluded:found.excluded};
}
// The sheet's combinations and, on an evaluation record, the one the hit guess was made from.
export function allCombinations(run){
  const present=new Set((run.clues||[]).map(clue=>clue.id)),guess=guessCombination(run);
  return [...(run.rules?.combinations||[]).filter(combo=>combo.clueIds.every(id=>present.has(id))),...(guess?[guess]:[])];
}
// What the hit guess raises to high (owner's decisions of 2026-11-17 and 2026-11-18):
//   mode 'solo'      only the clues that give the place away by themselves. Those the sheet already
//                    reads as a point are high as they are; the others (found by a search or when
//                    tried alone) are raised. A supporting clue keeps its risk.
//   mode 'combined'  every clue of the combination: none does it alone, together they did.
//   mode 'untested'  nothing yet.
// The unit stays the sheet's reading; `raised` says what the risk was before and why, and RAISED_NOTE
// is added to the end of the clue's description wherever it is shown. A clue that was already high is
// not raised and gets no note.
export const RAISED_NOTE='(단서 추정에 이용되어 등급이 증가하였습니다)';
export const withRaisedNote=(text,rule)=>rule?.raised&&typeof text==='string'&&!text.endsWith(RAISED_NOTE)?`${text} ${RAISED_NOTE}`:text;
// clue => judgement for the clues of one record, with the raise applied. ruleOf(clue) is the sheet's own reading.
export function ruleFor(run){
  const combo=guessCombination(run),raisedIds=new Set(combo&&combo.mode!=='untested'?combo.clueIds:[]);
  return clue=>{
    const rule=ruleOf(clue);
    return raisedIds.has(clue.id)&&rule.risk!=='high'?{...rule,risk:'high',raised:{from:rule.risk,by:combo.mode==='solo'?`address_guess_${combo.soloBy[clue.id]}`:'address_guess_combined'}}:rule;
  };
}
// {clues:{id:judgement}, counts:{high,medium,low}, judged, combinations:[...]} for one record.
export function ruleMarks(run){
  const clues={},counts={high:0,medium:0,low:0},judge=ruleFor(run);
  for(const clue of run.clues||[]){clues[clue.id]=judge(clue);counts[clues[clue.id].risk]++;}
  return {clues,counts,judged:Boolean(run.rules),combinations:allCombinations(run)};
}
// Which old linking tier a judged clue takes (paper-regions.mjs policy): a high or medium clue is
// looked for by both tools, a low one by text matching only, a regional-style one not at all.
export const linkingTierOf=clue=>clue.rule?(clue.rule.risk!=='low'?'A':clue.rule.class==='regional'?'C':'B'):null;
// Clues that took part in an inference of the place, whatever their own risk (added 2026-11-17):
//   a member of a combination the sheet admits (a distant tower is low alone, and half of what gives
//   the place away together with the gate in front of it);
//   a clue a map search of which led to the true place (records with a true position only);
//   a clue an address guess that found the place said it used (guessCombination; added 2026-11-17).
// Such a clue has to be coverable, so it is looked for by both tools even when it is low: without a
// region the front end can neither show it nor mask it.
export function usedClueIds(run){
  const used=new Set(allCombinations(run).flatMap(combo=>combo.clueIds));
  for(const [id,mark] of Object.entries(riskLabels(run).clues))if(mark.label==='confirmed')used.add(id);
  return used;
}
export const linkingTierFor=run=>{const used=usedClueIds(run);return clue=>used.has(clue.id)?'A':linkingTierOf(clue);};
