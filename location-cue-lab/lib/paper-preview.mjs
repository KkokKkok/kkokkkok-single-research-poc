// Preview page for paper-method runs: each photo with its region boxes drawn on it and the clue
// list beside it. One self-contained HTML file (images embedded) for local viewing only: the
// photos and clues can reveal a location, so the page belongs in private-data and is not published.
import { sharp } from './config.mjs';

export const CLUE_COLORS=['#e6194b','#3cb44b','#4363d8','#f58231','#911eb4','#008080','#f032e6','#9a6324','#800000','#808000','#000075','#e6beff','#aa6e28','#46f0f0'];
const colorOf=index=>CLUE_COLORS[index%CLUE_COLORS.length];
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);

const area=box=>Math.max(0,box[2]-box[0])*Math.max(0,box[3]-box[1]);
const iou=(a,b)=>{const inter=area([Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])]);const union=area(a)+area(b)-inter;return union?inter/union:0;};
// 'unverified' is the model's box standing in for a text OCR could not read (paper-text-recheck.mjs): last.
const MATCH_ORDER={exact:0,fuzzy:1,fuzzy_syllables:2,quote_in_line:3,line_in_quote:4,quote_near_line_part:5,line_near_quote_part:6,quote_near_line_syllables:7,line_near_quote_syllables:8,unverified:9};
// What is drawn and counted for a clue. The record keeps every proposal; the picture shows one box
// per place: OCR reads the same sign several times (tiles), and DINO returns several boxes a phrase.
export function displayRegions(clue,{minScore=0.35,perPhrase=1}={}){
  const text=(clue.regions||[]).filter(region=>region.kind==='text').sort((a,b)=>(MATCH_ORDER[a.match]??8)-(MATCH_ORDER[b.match]??8));
  const perQuery=new Map();
  // A detector box that spans the whole width or height of the photo ("red cart handle" as a band from
  // edge to edge) is the detector failing to pick anything out; it is kept in the record, not drawn.
  const spans=box=>box[2]-box[0]>=0.9||box[3]-box[1]>=0.9;
  const objects=(clue.regions||[]).filter(region=>region.kind==='object'&&region.score>=minScore&&!spans(region.bbox)).sort((a,b)=>b.score-a.score)
    .filter(region=>{const seen=perQuery.get(region.query)||0;perQuery.set(region.query,seen+1);return seen<perPhrase;});
  const kept=[];
  for(const region of [...text,...objects])if(!kept.some(other=>iou(other.bbox,region.bbox)>0.6))kept.push(region);
  return kept;
}

// Boxes are labelled with the clue number only (digits render without needing a Korean font).
// Solid outline: OCR text line matched to a quoted string. Dashed: Grounding DINO detection.
export function overlaySvg(clues,width,height){
  const parts=[];
  clues.forEach((clue,index)=>{
    for(const region of displayRegions(clue)){
      const [x0,y0,x1,y1]=region.bbox,x=x0*width,y=y0*height,w=Math.max(2,(x1-x0)*width),h=Math.max(2,(y1-y0)*height),color=colorOf(index),label=String(index);
      const labelWidth=8+7*label.length,labelY=y>=16?y-16:y;
      // An OCR line is drawn along its own outline (a slanted sign as it lies); a detector box as a box.
      const outline=region.kind==='text'&&Array.isArray(region.polygon)&&region.polygon.length>=3;
      const shape=outline?`polygon points="${region.polygon.map(point=>`${(point[0]*width).toFixed(1)},${(point[1]*height).toFixed(1)}`).join(' ')}" stroke-linejoin="round"`:`rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"`;
      parts.push(`<${shape} fill="none" stroke="#ffffff" stroke-width="4" stroke-opacity="0.85"/>`);
      parts.push(`<${shape} fill="none" stroke="${color}" stroke-width="2"${region.kind==='object'?' stroke-dasharray="7 4"':''}/>`);
      parts.push(`<rect x="${x.toFixed(1)}" y="${labelY.toFixed(1)}" width="${labelWidth}" height="16" fill="${color}"/><text x="${(x+4).toFixed(1)}" y="${(labelY+12.5).toFixed(1)}" fill="#ffffff" font-size="12" font-weight="bold" font-family="Arial, sans-serif">${label}</text>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}
export async function renderOverlay(bytes,clues,displayWidth=640){
  const base=sharp(bytes).resize({width:displayWidth,withoutEnlargement:true});
  const {data,info}=await base.toBuffer({resolveWithObject:true});
  return sharp(data).composite([{input:Buffer.from(overlaySvg(clues,info.width,info.height))}]).jpeg({quality:82}).toBuffer();
}

const regionSummary=clue=>{
  const shown=displayRegions(clue),text=shown.filter(r=>r.kind==='text').length,object=shown.filter(r=>r.kind==='object').length;
  if(!text&&!object)return '<span class="none">영역 없음</span>';
  return [text?`글자 영역 ${text}개`:'',object?`물체 영역 ${object}개`:''].filter(Boolean).join(' · ');
};
function targetDetails(clue){
  const matchedQuotes=new Set((clue.regions||[]).filter(r=>r.kind==='text').map(r=>r.quoted));
  const quotes=(clue.textTargets||[]).map(target=>`<li>${matchedQuotes.has(target)?'✓':'–'} <code>${escapeHtml(target)}</code></li>`).join('');
  const phrases=(clue.objectTargets||[]).map(phrase=>{const boxes=(clue.regions||[]).filter(r=>r.kind==='object'&&r.query===phrase);return `<li>${boxes.length?'✓':'–'} <code>${escapeHtml(phrase)}</code>${boxes.length?` (${boxes.map(b=>b.score.toFixed(2)).join(', ')})`:''}</li>`;}).join('');
  return `${quotes?`<p class="sub">따옴표로 적힌 글자 → OCR 대조</p><ul>${quotes}</ul>`:''}${phrases?`<p class="sub">검출 문구 → Grounding DINO (점수)</p><ul>${phrases}</ul>`:''}`;
}
const metres=value=>value>=1000?`${(value/1000).toFixed(1)}km`:`${Math.round(value)}m`;
// Evaluation result of the address prediction ("virtual attacker"), when the record has one.
// Within the radius: the clues the model said it used are listed as presumed risk evidence.
// korean.risk, when present, holds Korean renderings of those clues in the same order.
function predictionBlocks(run,korean){
  return (run.predictions||[]).map(prediction=>{
    const score=prediction.score,hit=score?.status==='scored'&&score.withinRadius===true;
    const verdict=!score?'아직 채점하지 않음':score.status!=='scored'?'채점 불가: 답을 좌표로 바꾸지 못함':hit?`맞힘: 실제 위치에서 ${metres(score.distanceM)} (기준 ${metres(score.radiusM)} 이내)`:`못 맞힘: 실제 위치에서 ${metres(score.distanceM)} (기준 ${metres(score.radiusM)} 밖)`;
    const translated=korean?.risk?.length===prediction.clueList?.length?korean.risk:null;
    const clues=hit?`<p class="sub">위험 근거(추정): 이 추정에서 모델이 썼다고 밝힌 단서</p><ol>${prediction.clueList.map((clue,index)=>`<li>${escapeHtml(translated?.[index]??clue)}</li>`).join('')}</ol>`:'';
    return `<div class="attack ${hit?'hit':'other'}"><p><strong>가상 공격자의 위치 추정</strong> · ${escapeHtml(prediction.model)} · ${escapeHtml(verdict)}</p>
<p class="sub">모델이 낸 답: ${(prediction.addressList||[]).map(address=>`<code>${escapeHtml(address)}</code>`).join(' ')||'없음'}</p>${clues}</div>`;
  }).join('\n');
}
// Place-search results (paper.mjs places): for each text quoted from the photo, how many businesses
// the map search returned and whether the first one, or any shown, is the place itself.
function placeBlock(run){
  if(!run.placeSearches?.length)return '';
  const revealing=run.placeSearches.filter(search=>search.topWithinRadius).length;
  const rows=run.placeSearches.map(search=>{
    const verdict=search.status!=='resolved'?'<span class="none">검색 결과 없음</span>':search.topWithinRadius?'<strong>첫 결과가 이 장소</strong>':search.anyWithinRadius?`${search.bestRank}번째 결과가 이 장소`:'다른 곳만 나옴';
    return `<tr><td><code>${escapeHtml(search.query)}</code>${search.seenByOcr?'':' <span class="none">(OCR은 못 읽음)</span>'}</td><td>${search.status==='resolved'?`${search.total??search.results.length}곳`:'—'}</td><td>${search.topDistanceM===null?'—':metres(search.topDistanceM)}</td><td>${verdict}</td></tr>`;
  }).join('\n');
  return `<div class="attack ${revealing?'hit':'other'}"><p><strong>사진 속 글자를 장소 검색에 넣은 결과</strong> · ${run.placeSearches.length}개 중 ${revealing}개가 첫 결과로 이 장소를 가리킴 (기준 ${metres(run.placeSearches[0].radiusM)})</p>
<table><thead><tr><th>검색한 글자</th><th>검색된 곳</th><th>첫 결과까지 거리</th><th>판정</th></tr></thead><tbody>
${rows}
</tbody></table></div>`;
}
// Counts the classified clues per taxonomy category across records. Category numbers only mean
// something within one taxonomy, so only records classified with `taxonomyId` are counted (default:
// the taxonomy of the most recently classified record).
// revealing: clues one of whose quoted texts, typed into place search, returned the true place first
// (paper.mjs places). poorFit: clues a reviewer marked as having no fitting category (korean.poorFit).
export function taxonomyTally(entries,taxonomyId=null){
  const classified=entries.filter(({run})=>run.classification?.taxonomyId);
  taxonomyId??=classified.slice().sort((a,b)=>a.run.classification.classifiedAt.localeCompare(b.run.classification.classifiedAt)).at(-1)?.run.classification.taxonomyId??null;
  const rows=new Map();let clues=0,poorFit=0,photos=0;
  for(const {run,korean} of classified){
    if(run.classification.taxonomyId!==taxonomyId)continue;
    photos++;
    const revealing=new Set((run.placeSearches||[]).filter(search=>search.topWithinRadius).flatMap(search=>search.clueIds||[]));
    const marked=new Set(korean?.poorFit||[]);
    for(const clue of run.clues){
      if(!clue.taxonomy)continue;
      const row=rows.get(clue.taxonomy.number)??{number:clue.taxonomy.number,name:clue.taxonomy.name,group:clue.taxonomy.group??null,clues:0,photoIds:new Set(),revealing:0,poorFit:0};
      row.clues++;row.photoIds.add(run.id);clues++;
      if(revealing.has(clue.id))row.revealing++;
      if(marked.has(clue.id)){row.poorFit++;poorFit++;}
      rows.set(clue.taxonomy.number,row);
    }
  }
  return {taxonomyId,photos,clues,poorFit,rows:[...rows.values()].map(({photoIds,...row})=>({...row,photos:photoIds.size})).sort((a,b)=>b.clues-a.clues||a.number-b.number)};
}
function tallyBlock(entries,labels){
  const tally=taxonomyTally(entries);
  if(!tally.rows.length)return '';
  const named=name=>labels[name]?`${escapeHtml(labels[name])} <span class="taxonomy">${escapeHtml(name)}</span>`:escapeHtml(name);
  const rows=tally.rows.map(row=>`<tr><td>${row.group?named(row.group):'—'}</td><td>${row.number}. ${named(row.name)}</td><td>${row.clues}</td><td>${row.photos}</td><td>${row.revealing||'—'}</td><td>${row.poorFit||'—'}</td></tr>`).join('\n');
  return `<section>
<h2>범주별 집계</h2>
<p class="meta">사진 ${tally.photos}장 · 분류된 단서 ${tally.clues}개 · 쓰인 범주 ${tally.rows.length}개 · 맞는 범주가 없다고 검토자가 표시한 단서 ${tally.poorFit}개 · 범주 체계 <code>${escapeHtml(tally.taxonomyId)}</code></p>
<div class="tablewrap"><table><thead><tr><th>묶음</th><th>범주</th><th>단서 수</th><th>나온 사진 수</th><th>장소 검색으로 위치가 드러난 단서</th><th>맞는 범주 없음</th></tr></thead><tbody>
${rows}
</tbody></table></div>
</section>`;
}
// entries: [{run, overlay: Buffer(JPEG), korean: {clueId: text, risk?: [text], poorFit?: [clueId]} | undefined}]
// taxonomyLabels: {English category or group name: display name}.
export function buildPreviewHtml(entries,{generatedAt=new Date().toISOString(),taxonomyLabels={}}={}){
  const label=name=>taxonomyLabels[name]?`${taxonomyLabels[name]} (${name})`:name;
  const sections=entries.map(({run,overlay,korean},photoIndex)=>{
    const poorFit=new Set(korean?.poorFit||[]);
    const rows=run.clues.map((clue,index)=>`<tr>
<td><span class="chip" style="background:${colorOf(index)}">${index}</span></td>
<td><div class="category">${escapeHtml(clue.category)}${clue.taxonomy?` <span class="taxonomy">→ ${clue.taxonomy.number}. ${escapeHtml(label(clue.taxonomy.name))}${clue.taxonomy.group?` · ${escapeHtml(label(clue.taxonomy.group))}`:''}</span>${poorFit.has(clue.id)?' <span class="misfit">맞는 범주 없음</span>':''}`:''}</div>
${korean?.[clue.id]?`<div class="ko">${escapeHtml(korean[clue.id]).replace(/\[위치 추정\]/g,'<span class="guess">위치 추정</span>')}</div>`:''}
<details><summary>원문과 영역 근거</summary><p class="en">${escapeHtml(clue.detail)}</p>${targetDetails(clue)}</details></td>
<td class="regions">${regionSummary(clue)}</td></tr>`).join('\n');
    const located=run.clues.filter(clue=>displayRegions(clue).length).length;
    return `<section>
<h2>사진 ${photoIndex+1}</h2>
<p class="meta">단서 ${run.clues.length}개 · 영역이 붙은 단서 ${located}개 · 추출 모델 ${escapeHtml(run.stages?.detector?.model??'?')} (${escapeHtml(run.stages?.detector?.transport??'?')}) · 기록 <code>${escapeHtml(run.id)}</code></p>
${predictionBlocks(run,korean)}
${placeBlock(run)}
<div class="photo"><img alt="사진 ${photoIndex+1}과 단서 영역" src="data:image/jpeg;base64,${overlay.toString('base64')}"><div class="tablewrap"><table><thead><tr><th>#</th><th>단서</th><th>영역</th></tr></thead><tbody>
${rows}
</tbody></table></div></div>
</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>논문 방식 단서 미리보기</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#62625c;--card:#ffffff;--line:#deded8;--code:#efefea}
@media (prefers-color-scheme: dark){:root{--bg:#161614;--fg:#ecece6;--muted:#a3a39b;--card:#20201d;--line:#3a3a35;--code:#2b2b27}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.55 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto}h1{font-size:22px;margin:0 0 8px}h2{font-size:18px;margin:0 0 4px}
.note{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0 24px}.note ul{margin:6px 0 0;padding-left:20px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 24px}
.meta{color:var(--muted);font-size:13px;margin:0 0 12px}.photo{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.photo img{width:420px;max-width:100%;height:auto;border-radius:4px;border:1px solid var(--line)}.tablewrap{flex:1 1 420px;min-width:0;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:8px 8px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:600}
.chip{display:inline-block;min-width:24px;padding:1px 6px;border-radius:4px;color:#fff;font-weight:700;font-size:13px;text-align:center}
.category{font-weight:600}.taxonomy{color:var(--muted);font-weight:400}.ko{margin-top:2px}.en{color:var(--muted);font-size:13px;margin:6px 0}
.attack{border-left:4px solid var(--line);background:var(--code);border-radius:0 6px 6px 0;padding:8px 12px;margin:0 0 12px}.attack.hit{border-left-color:#b3261e}.attack p{margin:0 0 4px}.attack ol{margin:4px 0 0;padding-left:22px;font-size:14px}
.guess{display:inline-block;background:#b3261e;color:#fff;border-radius:4px;padding:0 6px;font-size:12px;font-weight:700;margin-right:2px}
.misfit{display:inline-block;border:1px solid var(--muted);color:var(--muted);border-radius:4px;padding:0 6px;font-size:12px;font-weight:400}
.regions{white-space:nowrap;font-size:13px}.none{color:var(--muted)}details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:13px}
.sub{margin:8px 0 2px;font-size:12px;color:var(--muted)}ul{margin:0;padding-left:18px;font-size:13px}code{background:var(--code);padding:0 4px;border-radius:3px;font-size:12px}
.legend span{display:inline-block;width:26px;height:0;border-top:2px solid var(--fg);vertical-align:middle;margin-right:6px}.legend .dash{border-top-style:dashed}
</style></head><body><main>
<h1>논문 방식 단서 미리보기</h1>
<div class="note">사진 ${entries.length}장 · 생성 ${escapeHtml(generatedAt)}
<ul>
<li>단서는 DoxBench의 Detector 프롬프트 원문에 모델이 답한 것입니다. 한글 설명은 읽기 쉽게 옮긴 요약이고, 원문은 각 단서의 "원문과 영역 근거"에 있습니다.</li>
<li>상자의 숫자와 색은 오른쪽 표의 단서 번호입니다. 한 단서에 상자가 여러 개일 수 있고, 한 영역으로 가리킬 수 없는 단서는 "영역 없음"입니다.</li>
<li class="legend"><span></span>실선: 단서가 따옴표로 적은 글자를 OCR이 읽은 줄과 대조해 찾은 영역 &nbsp; <span class="dash"></span>점선: 단서에서 뽑은 문구로 Grounding DINO가 찾은 영역</li>
<li>같은 자리의 상자는 하나만 그렸습니다. 점선 상자는 문구마다 점수가 가장 높은 것 하나를, 점수 0.35 이상일 때만 그렸습니다. 기록에는 모든 후보가 남아 있습니다.</li>
<li>영역은 검증하지 않은 제안입니다. 상자가 단서와 다른 대상을 가리킬 수 있습니다. 영역 연결은 논문에 없는, 이 프로젝트가 추가한 단계입니다.</li>
<li><span class="guess">위치 추정</span> 표시는 모델이 관찰을 넘어 기관·주소·좌표를 추정해 적은 단서입니다. 프롬프트는 추정을 요구하지 않았지만 모델이 덧붙였습니다.</li>
<li>"가상 공격자의 위치 추정"은 평가용 실험입니다. 사진만 보여 주고 어디인지 물은 뒤, 모델의 답을 원본 사진의 EXIF 좌표와 비교했습니다. 기준 반경 안이면 그 추정에 쓰인 단서를 위험 근거로 추정합니다. 모델이 스스로 적은 목록이라 어느 단서가 결정적이었는지는 알 수 없고, 못 맞힌 사진의 단서가 안전하다는 뜻도 아닙니다.</li>
<li>단서 이름 뒤의 "→ 번호. 범주"는 분류 결과입니다. 분류기는 단서마다 범주 체계에서 반드시 하나를 고르게 돼 있어, 맞는 범주가 없는 단서에도 범주가 붙습니다. <span class="misfit">맞는 범주 없음</span> 표시는 사람이 검토해 붙인 것이고 분류기의 판단이 아닙니다.</li>
</ul></div>
${tallyBlock(entries,taxonomyLabels)}
${sections}
</main></body></html>
`;
}
