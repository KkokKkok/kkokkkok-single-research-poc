// The label each clue gets for the front end (rule agreed on 2026-11-15; not from the paper):
//   confirmed  a map search led to the true place: its text alone, or in combination
//   potential  tier A, and no search led to the place. Whether a tool found it in the photo is told
//              apart (`located`), but does not lower the label: OCR misses real text too often
//              (8 of the 25 texts that led to the place were not read by OCR)
//   low        tier B or C, or tier A whose quoted texts
//              find nothing on the map in the assumed area (added 2026-11-15)
// A category's tier is only the default (paper-risk-tiers.mjs); `confirmed` is the measured part.
// The address guess is an evaluation element kept inside: a guess that hit marks the PHOTO
// (photo.guessHit), not a clue, because the guess does not say which clue decided it.
import { riskTierOf } from './paper-risk-tiers.mjs';

export const COMBINATION_RADIUS_M=150;
export const RISK_LABEL_KO={confirmed:'확인된 위험',potential:'잠재 위험',low:'낮음'};
const metres=value=>value>=1000?`${(value/1000).toFixed(1)}km`:`${Math.round(value)}m`;

// Clue ids whose quoted texts were all typed into the map search (paper-probe.mjs, which needs no
// true position) and none has a single result in the assumed area. Such a text never led to the
// place in the measurement of 2026-11-15 (0 of 114), so a tier A clue that rests only on such texts
// is shown as low. A clue with no quoted text is not in this set: nothing was searched for it.
export function cluesWithoutAreaResult(run){
  const byClue=new Map();
  for(const probe of run.placeProbes||[])for(const id of probe.clueIds||[]){if(!byClue.has(id))byClue.set(id,[]);byClue.get(id).push(probe);}
  return new Set([...byClue].filter(([,probes])=>probes.every(probe=>probe.inAreaCount===0)).map(([id])=>id));
}

// Where a clue is in the photo, as far as the tools can be trusted (changed 2026-11-15):
//   a clue that quotes text is located only by an OCR line that reads that text. An object box for
//   such a clue is not evidence: the detector, asked for "beer sign", will box a drink.
//   a clue that quotes nothing is located by an object box.
export const hasQuotedText=clue=>(clue.textTargets||[]).length>0;
//   a box the model pointed at (kind 'pointed', scripts/pointing-experiment.mjs) is a suggestion to
//   be checked, not a location: it never counts.
export const trustedRegions=clue=>(clue.regions||[]).filter(region=>region.kind!=='pointed'&&(hasQuotedText(clue)?region.kind==='text':true));

// Returns {clues:{clueId:{label,tier,located,reason,evidence:[text]}},counts:{confirmed,potential,low},searched,probed}.
// searched: the record has place-search results, so `confirmed` could be decided at all. Without
// them (no true position to compare with) the best a clue can get is `potential`.
export function riskLabels(run){
  const evidence=new Map(),add=(id,text)=>{if(!evidence.has(id))evidence.set(id,[]);evidence.get(id).push(text);};
  for(const single of run.placeSearches||[])if(single.topWithinRadius)for(const id of single.clueIds||[])add(id,`지도 검색 "${single.searchedAs??single.query}"${single.searchedAs?' (인용문을 줄여서 검색)':''} → 첫 결과가 실제 위치 (${metres(single.topDistanceM)})`);
  for(const combo of run.comboSearches||[]){
    // An area search whose guess was already at the place says nothing about the text (paper-combo.mjs).
    // A combination has to land much closer than a single search to count (COMBINATION_RADIUS_M):
    // it claims to have found the very place, and in a dense district some unrelated shop is always
    // within 500 m. Set on 2026-11-15 after the first run: its three combination hits (221-437 m) were
    // all other businesses that merely stood nearby.
    if(combo.withinRadius!==true||combo.distanceM>COMBINATION_RADIUS_M||(combo.kind==='area'&&combo.guessWithinRadius))continue;
    const text=combo.kind==='pair'
      ?`조합 검색 "${combo.texts[0]}" + "${combo.texts[1]}" → 실제 위치 (${metres(combo.distanceM)})`
      :`추정 지역(${combo.area}) + "${combo.texts[0]}" → 실제 위치 (${metres(combo.distanceM)})`;
    for(const id of new Set(combo.clueIds.flat()))add(id,text);
  }
  const unfindable=cluesWithoutAreaResult(run);
  const clues={},counts={confirmed:0,potential:0,low:0};
  for(const clue of run.clues){
    // The tier table as it is now, not the tier stored when the regions were linked.
    const tier=riskTierOf(clue.taxonomy?.name)??clue.risk?.tier??'A',located=trustedRegions(clue).length>0,proof=evidence.get(clue.id)||[];
    // A search that led to the place always wins over a count that says nothing was found.
    const nowhere=!proof.length&&tier==='A'&&unfindable.has(clue.id);
    const label=proof.length?'confirmed':tier==='A'&&!nowhere?'potential':'low';
    const reason=proof.length?'지도 검색으로 실제 위치가 나옴':tier!=='A'?`등급 ${tier}`
      :nowhere?'A 등급이지만, 인용한 글자를 지도에서 검색해도 이 지역에 나오는 곳이 없음'
      :located?'A 등급. 검색으로는 위치가 나오지 않음':hasQuotedText(clue)?'A 등급. 인용한 글자를 사진에서 찾지 못해 상자가 없음':'A 등급. 사진에서 위치를 찾지 못해 상자가 없음';
    clues[clue.id]={label,tier,located,reason,evidence:proof};counts[label]++;
  }
  return {clues,counts,searched:Boolean(run.placeSearches),probed:Boolean(run.placeProbes)};
}

// Counts a person's answers from the viewer against the label each clue has now.
// reviews: {"<recordId>/<clueId>": {box,category,risk,at}}. Returns {reviewed,unknown,byLabel}:
// byLabel[label] = {clues, box:{right,partial,wrong}, category:{right,wrong}, risk:{yes,no,unsure}}.
// unknown: answers whose record or clue no longer exists.
export function reviewSummary(runs,reviews){
  const labelOf=new Map();
  for(const run of runs){const marks=riskLabels(run).clues;for(const clue of run.clues)labelOf.set(`${run.id}/${clue.id}`,marks[clue.id].label);}
  const blank=()=>({clues:0,box:{right:0,partial:0,wrong:0},category:{right:0,wrong:0},risk:{yes:0,no:0,unsure:0}});
  const byLabel={confirmed:blank(),potential:blank(),low:blank()};
  let reviewed=0,unknown=0;
  for(const [key,answer] of Object.entries(reviews||{})){
    const label=labelOf.get(key);
    if(!label){unknown++;continue;}
    const fields=['box','category','risk'].filter(field=>answer[field]&&byLabel[label][field][answer[field]]!==undefined);
    if(!fields.length)continue;
    reviewed++;byLabel[label].clues++;
    for(const field of fields)byLabel[label][field][answer[field]]++;
  }
  return {reviewed,unknown,byLabel};
}
