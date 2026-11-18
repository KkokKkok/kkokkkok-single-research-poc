// Interactive viewer for paper-method records: one photo at a time, with each clue's region boxes
// drawn by the page (not baked into the picture) so they can be switched on and off per clue.
// Local viewing only, like the preview page: photos and clues can reveal a location, so the output
// belongs in private-data and is not published. Three parts are written by `paper.mjs viewer`:
//   index.html   the page (no photo data in it)
//   data.js      window.VIEWER_DATA = {...}; a script file so the page also works from file://
//   images/<recordId>.jpg   the analysis image, resized, without boxes
import { displayRegions,CLUE_COLORS } from './paper-preview.mjs';
import { riskLabels,hasQuotedText } from './paper-risk.mjs';
import { ruleMarks,withRaisedNote } from './paper-rules.mjs';
import { guessVerdict,latestPrediction } from './paper-guess.mjs';
import { createHash } from 'node:crypto';

// The clues a person is asked to check: every confirmed one, and a fixed sample of the potential
// ones. The sample is the first `size` by the hash of record and clue id, so it is the same on every
// run and does not depend on the order of the photos.
export function reviewSample(entries,size){
  const potential=[];
  const chosen=new Set();
  for(const {run} of entries){
    const marks=riskLabels(run).clues;
    for(const clue of run.clues){
      const key=`${run.id}/${clue.id}`;
      if(marks[clue.id].label==='confirmed')chosen.add(key);
      else if(marks[clue.id].label==='potential')potential.push([createHash('sha256').update(key).digest('hex'),key]);
    }
  }
  for(const [,key] of potential.sort((a,b)=>a[0].localeCompare(b[0])).slice(0,size))chosen.add(key);
  return chosen;
}

// The address guess verdict lives in paper-guess.mjs (it also decides which clues the guess used).
export { guessVerdict };

// A warning about the photo as a whole, for the case boxes cannot handle. The mask experiment (m1, m2,
// 2026-11-15) showed that a photo with no readable text can still be placed from the scene itself — a
// riverside, a hill with a tower — and painting over the marked clues does not stop it. So when the
// address guess found the place, the photo is flagged whatever its clues say:
//   scene            the guess was right and no clue was confirmed by a search: the place came from
//                    the picture as a whole, or from clues no search could verify
//   scene_and_clue   the guess was right and some clue was confirmed too
// The warning carries no address and no distance, so it is safe to hand to a product front end.
// Like "confirmed", it needs the photo's true position (or the folder reference) to judge the guess.
//   text             (added 2026-11-16) the guess was right, no clue was confirmed, but the guess's own
//                    clue list quotes text it read in the photo: the place most likely came from
//                    that text, which a search failed to verify, not from the scene
// Text in quotes in a clue of the guess: '...' or "..." that opens after a space, so "water's" is not one.
const QUOTED_IN_GUESS=/(^|[\s(\[])['"‘“][^'"‘’“”]{2,}['"’”](?=$|[\s,.;:)\]])/;
export const guessQuotesText=run=>(latestPrediction(run)?.clueList||[]).some(clue=>QUOTED_IN_GUESS.test(clue));
export function photoWarning(run,counts=riskLabels(run).counts){
  if(!guessVerdict(run)?.hit)return null;
  return counts.confirmed
    ?{kind:'scene_and_clue',title:'사진 전체로도 위치가 추정됩니다',text:'주소 추정이 이 사진의 위치를 맞혔습니다. 확인된 위험 단서를 가려도 나머지 장면으로 위치가 드러날 수 있습니다.'}
    :guessQuotesText(run)
    ?{kind:'text',title:'사진 속 글자로 위치가 추정됩니다',text:'주소 추정이 사진에 적힌 글자를 근거로 들어 위치를 맞혔습니다. 지도 검색으로는 그 글자가 확인되지 않아 어느 단서인지 특정하지 못했습니다. 글자가 적힌 단서를 먼저 살펴보세요.'}
    :{kind:'scene',title:'사진 전체로 위치가 추정됩니다',text:'주소 추정이 이 사진의 위치를 맞혔지만, 지도 검색으로 확인된 단서는 없습니다. 특정 단서 하나가 아니라 장면 전체에서 위치가 드러난 것일 수 있어, 상자를 가리는 것으로는 막기 어렵습니다.'};
}

// entries: [{run, korean, title, folder}] in display order. labels: {English name: Korean name}.
// Every region proposal is kept (`shown` marks the ones the preview would draw), so the page can
// offer both the tidy default and all candidates.
// Risk (changed 2026-11-17): what a clue's risk is comes from the owner's rule sheet (paper-rules.mjs):
// clue.rule = {class,situation,basis,unit,risk,...} and photo.combinations, in place of the category
// tier (A/B/C) and the labels confirmed/potential/low. What the evaluation measured is kept beside it,
// not as a risk level: clue.confirmed (a map search of this clue led to the true place) and photo.measured.
// internal (default true, for the proof of concept): the page also shows what the evaluation knows —
// the guessed address, distances to the true position, the guessed district and the search terms that
// led to the place. With internal:false none of that is put into the data: a clue carries its label
// and a plain reason only, and the guess is reduced to hit or miss. That is the shape a product
// front end may receive.
export function viewerData(entries,{labels={},generatedAt=new Date().toISOString(),internal=true,reviewSize=45}={}){
  const toReview=reviewSample(entries,reviewSize);
  const photos=entries.map(({run,korean,title,folder,pick})=>{
    const risk=riskLabels(run),rules=ruleMarks(run),numberOf=new Map(run.clues.map((clue,index)=>[clue.id,index+1]));
    const clues=run.clues.map((clue,index)=>{
      const shown=new Set(displayRegions(clue)),mark=risk.clues[clue.id];
      return {n:index+1,id:clue.id,category:clue.category,
        review:toReview.has(`${run.id}/${clue.id}`),rule:rules.clues[clue.id],combinations:rules.combinations.filter(combo=>combo.clueIds.includes(clue.id)).map(combo=>combo.id),confirmed:mark.label==='confirmed',evidence:internal?mark.evidence:[],
        taxonomy:clue.taxonomy?{number:clue.taxonomy.number,name:clue.taxonomy.name,ko:labels[clue.taxonomy.name]||clue.taxonomy.name,group:clue.taxonomy.group??null,groupKo:clue.taxonomy.group?(labels[clue.taxonomy.group]||clue.taxonomy.group):null}:null,
        located:mark.located,locatedBy:mark.locatedBy,quotes:hasQuotedText(clue),localization:clue.localization??null,
        ko:korean?.[clue.id]?withRaisedNote(korean[clue.id],rules.clues[clue.id]):null,en:withRaisedNote(clue.detail,rules.clues[clue.id]),textTargets:clue.textTargets||[],objectTargets:clue.objectTargets||[],
        // 'p': a box the model pointed at (pointing experiment). Always drawn, long-dashed, never counted.
        // Detector boxes of a clue that quotes text are left out altogether (2026-11-16): they are never counted,
        // the detector is no longer asked for such clues, and under "모든 후보 보기" the old ones showed up as large
        // wrong boxes (two tall "exhibition poster" boxes for a clue about the text on the wall).
        regions:(clue.regions||[]).filter(region=>!(region.kind==='object'&&hasQuotedText(clue))).map(region=>({kind:region.kind==='text'?'t':region.kind==='pointed'?'p':'o',bbox:region.bbox.map(value=>Math.round(value*10000)/10000),
          // An OCR line keeps its outline (2026-11-16): a slanted sign is drawn as it lies, not as the upright box around it.
          ...(region.kind==='text'&&Array.isArray(region.polygon)&&region.polygon.length>=3?{polygon:region.polygon.map(point=>[point[0],point[1]].map(value=>Math.round(value*10000)/10000))}:{}),
          // A detector box with a Segment Anything mask (paper-masks.mjs) carries it as run lengths; the page paints it.
          ...(region.kind==='object'&&region.mask?{mask:{size:region.mask.size,counts:region.mask.counts}}:{}),
          // standIn: the model's box in place of a text OCR could not read. Counted as located, drawn dashed.
          ...(region.verified===false&&region.kind!=='pointed'?{standIn:true}:{}),
          label:region.kind==='text'?region.quoted:region.kind==='pointed'?'모델이 짚은 위치':region.query??'모델이 짚은 물체',score:region.kind==='object'&&region.score!==null?Math.round(region.score*100)/100:null,
          shown:region.kind==='pointed'||(shown.has(region)&&!(region.kind==='object'&&hasQuotedText(clue)))}))};
    });
    const verdict=guessVerdict(run),combos=run.comboSearches||[];
    return {id:run.id,title,folder:folder??null,width:run.image.width,height:run.image.height,image:`images/${run.id}.jpg`,
      linked:Boolean(run.regions),boxes:clues.reduce((sum,clue)=>sum+clue.regions.filter(region=>region.shown).length,0),clues,
      warning:photoWarning(run,risk.counts),pick:pick??null,
      risk:{...rules.counts,judged:rules.judged},combinations:rules.combinations.map(combo=>({...combo,clueNs:combo.clueIds.map(id=>numberOf.get(id)),supportingNs:(combo.supporting||[]).map(id=>numberOf.get(id))})),
      measured:{confirmed:risk.counts.confirmed,searched:risk.searched,combinations:combos.length,revealingCombinations:combos.filter(combo=>combo.withinRadius===true).length},
      guess:verdict&&!internal?{hit:verdict.hit,text:verdict.hit?'맞힘':'못 맞힘',addresses:[],clues:[]}:verdict};
  });
  return {generatedAt,internal,colors:CLUE_COLORS,photos};
}

export const VIEWER_HTML=String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>단서 뷰어</title>
<style>
:root{--bg:#f4f4f1;--fg:#1c1c1a;--muted:#676760;--card:#ffffff;--line:#dcdcd5;--soft:#ecece6;--accent:#2f5fd0}
@media (prefers-color-scheme: dark){:root{--bg:#151513;--fg:#ecece6;--muted:#a2a29a;--card:#1f1f1c;--line:#383833;--soft:#2a2a26;--accent:#8fb0ff}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif}
button,select,input{font:inherit;color:inherit}
.app{display:grid;grid-template-columns:270px minmax(0,1fr);height:100vh}
aside{border-right:1px solid var(--line);background:var(--card);display:flex;flex-direction:column;min-height:0}
.filters{padding:12px;border-bottom:1px solid var(--line);display:grid;gap:8px}
.filters h1{font-size:16px;margin:0}.filters select,.filters input[type=search]{width:100%;padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
.filters label{display:flex;gap:6px;align-items:center;font-size:13px}.count{font-size:12px;color:var(--muted)}
.list{overflow:auto;flex:1}.folder{position:sticky;top:0;background:var(--soft);padding:4px 12px;font-size:12px;font-weight:700;color:var(--muted)}
.item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:none;padding:7px 12px;cursor:pointer}
.item:hover{background:var(--soft)}.item.on{background:var(--accent);color:#fff}.item .meta{display:block;font-size:12px;opacity:.75}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--line)}.dot.hit{background:#c62f24}.dot.miss{background:#8a8a82}
main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,1fr);min-height:0}
.stage{padding:14px;overflow:auto;min-height:0}.head{display:flex;gap:8px;align-items:center;margin:0 0 8px}.head h2{font-size:17px;margin:0;flex:1}
.nav{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:3px 10px;cursor:pointer}.nav:disabled{opacity:.4;cursor:default}
.imgwrap{position:relative;display:inline-block;max-width:100%;line-height:0;border:1px solid var(--line);border-radius:4px;overflow:hidden;background:#000}
.imgwrap img{display:block;max-width:100%;max-height:calc(100vh - 150px);height:auto;width:auto}.imgwrap svg{position:absolute;inset:0;width:100%;height:100%}
.imgwrap .box{cursor:pointer}.info{font-size:12px;color:var(--muted);margin:8px 0 0}.guess{font-size:13px;margin:8px 0 0;padding:6px 10px;border-left:4px solid var(--line);background:var(--soft);border-radius:0 6px 6px 0}
.guess.hit{border-left-color:#c62f24}.guess code{background:var(--card);padding:0 4px;border-radius:3px;font-size:12px}
.panel{border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0;background:var(--card)}
.tools{padding:10px 12px;border-bottom:1px solid var(--line);display:grid;gap:8px}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid var(--line);background:var(--bg);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:13px}.btn:hover{border-color:var(--accent)}
.tools label{font-size:13px;display:flex;gap:5px;align-items:center}.groups .btn.off,.levels .btn.off{opacity:.45;text-decoration:line-through}.levels .btn.high{border-color:#c62f24;color:#c62f24;font-weight:700}.levels .btn.medium{border-color:#b9770e;color:#b9770e;font-weight:700}.level{padding:4px 12px;font-size:12px;font-weight:700;background:var(--soft);color:var(--muted);border-bottom:1px solid var(--line)}.level.high{color:#c62f24}.level.medium{color:#b9770e}
.clues{overflow:auto;flex:1}.clue{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.clue:hover{background:var(--soft)}.clue.off .chip{background:transparent!important;color:var(--muted);border-color:var(--line)}.clue.off .body{opacity:.55}
.clue.nobox{cursor:default}.clue.flash{outline:2px solid var(--accent);outline-offset:-2px}
.chip{display:inline-block;min-width:28px;padding:1px 6px;border-radius:5px;border:2px solid transparent;color:#fff;font-weight:700;text-align:center}
.label{display:inline-block;border-radius:4px;padding:0 6px;font-size:11px;font-weight:700;margin-left:6px;border:1px solid var(--line);color:var(--muted)}.label.high{background:#c62f24;border-color:#c62f24;color:#fff}.label.medium{border-color:#b9770e;color:#b9770e}.label.measured{border-color:#c62f24;color:#c62f24}.rule{font-size:12px;color:var(--muted)}
.proof{font-size:12px;margin-top:3px;color:#c62f24}
.warn{margin:0 0 8px;padding:8px 12px;border:1px solid #c62f24;border-left-width:5px;border-radius:6px;background:var(--card);font-size:13px}.warn strong{color:#c62f24}.warn.scene{background:#c62f24;color:#fff}.warn.scene strong{color:#fff}
.pick{margin:0 0 8px;padding:8px 12px;border:1px solid var(--accent);border-left-width:5px;border-radius:6px;background:var(--card);font-size:13px}.pick strong{color:var(--accent)}
.flag{display:inline-block;border-radius:4px;padding:0 5px;font-size:11px;font-weight:700;margin-left:5px;background:#c62f24;color:#fff}.flag.also{background:transparent;color:#c62f24;border:1px solid #c62f24}.item.on .flag.also{color:#fff;border-color:#fff}.flag.pick{background:var(--accent)}.item.on .flag.pick{background:#fff;color:var(--accent)}
.review{margin-top:6px;padding:6px 8px;border:1px dashed var(--line);border-radius:6px;display:grid;gap:4px;cursor:default}.review .q{display:flex;gap:5px;align-items:center;flex-wrap:wrap;font-size:12px}.review .q span{min-width:64px;color:var(--muted)}
.review button{border:1px solid var(--line);background:var(--bg);border-radius:5px;padding:1px 8px;cursor:pointer;font-size:12px}.review button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.todo{display:inline-block;border-radius:4px;padding:0 6px;font-size:11px;font-weight:700;margin-left:6px;background:var(--accent);color:#fff}.todo.done{background:transparent;color:var(--muted);border:1px solid var(--line)}
.saved{font-size:12px;color:var(--muted)}.saved.bad{color:#c62f24}
.tier{display:inline-block;border-radius:4px;padding:0 5px;font-size:11px;font-weight:700;margin-right:5px;color:#fff;background:#8a8a82}.tier.high{background:#c62f24}.tier.medium{background:#b9770e}
.cat{font-weight:700}.tax{color:var(--muted);font-size:12px}.ko{margin-top:2px}.small{font-size:12px;color:var(--muted);margin-top:3px}
details{margin-top:4px}summary{cursor:pointer;color:var(--muted);font-size:12px}.en{font-size:12px;color:var(--muted);margin:4px 0}
.empty{padding:40px;color:var(--muted)}kbd{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:11px;background:var(--bg)}
@media (max-width:1000px){.app{grid-template-columns:1fr;height:auto}aside{max-height:45vh;overflow:auto}.list{overflow:visible}main{grid-template-columns:1fr}.panel{border-left:0;border-top:1px solid var(--line)}}
</style></head><body>
<div class="app">
<aside>
  <div class="filters">
    <h1>단서 뷰어</h1>
    <select id="fFolder" aria-label="폴더"></select>
    <select id="fGuess" aria-label="주소 추정"><option value="">주소 추정: 전체</option><option value="hit">맞힌 사진</option><option value="miss">못 맞힌 사진</option><option value="none">추정하지 않은 사진</option></select>
    <select id="fRisk" aria-label="위험 표시"><option value="">위험 표시: 전체</option><option value="high">높음이 있는 사진 (단서 또는 조합)</option><option value="medium">중간까지만 있는 사진</option><option value="none">낮음만 있는 사진</option><option value="combo">조합이 있는 사진</option><option value="confirmed">지도 검색으로 확인된 단서가 있는 사진</option><option value="unjudged">규칙 판정을 하지 않은 사진</option><option value="unsearched">지도 검색을 하지 못한 사진</option></select>
    <select id="fWarn" aria-label="사진 경고"><option value="">사진 경고: 전체</option><option value="any">사진 경고가 있는 사진</option><option value="scene">장면으로 추정된 사진 (글자 근거 없음)</option><option value="text">글자로 추정됐지만 확인된 단서가 없는 사진</option><option value="none">사진 경고가 없는 사진</option></select>
    <select id="fGroup" aria-label="묶음"></select>
    <input id="fSearch" type="search" placeholder="단서 내용·범주 검색">
    <label><input id="fPick" type="checkbox"> 먼저 봐 주셨으면 하는 사진만</label>
    <label><input id="fLinked" type="checkbox"> 상자가 있는 사진만</label>
    <label><input id="fReview" type="checkbox"> 검토할 단서가 있는 사진만</label>
    <label><input id="fTodo" type="checkbox"> 검토가 남은 사진만</label>
    <div class="count" id="count"></div>
    <div class="count" id="progress"></div>
    <div class="row"><button class="btn" id="exportReviews">검토 결과 내려받기</button><span class="saved" id="saved"></span></div>
  </div>
  <div class="list" id="list"></div>
</aside>
<main>
  <div class="stage" id="stage"></div>
  <div class="panel">
    <div class="tools">
      <div class="row"><button class="btn" id="allOn">모두 켜기</button><button class="btn" id="allOff">모두 끄기</button><button class="btn" id="riskOn">위험 단서만</button>
        <label><input id="oText" type="checkbox" checked> 글자(실선)·모델 상자로 대체(파선)</label><label><input id="oObject" type="checkbox" checked> 물체(점선)·모델이 짚은 위치(긴 점선)</label></div>
      <div class="row"><label><input id="oBig" type="checkbox" checked> 화면 절반을 넘는 큰 상자 숨기기</label><label><input id="oAll" type="checkbox"> 모든 후보 보기</label><label><input id="oMask" type="checkbox" checked> 물체 마스크 칠하기</label></div>
      <div class="row levels" id="levels"></div>
      <div class="row groups" id="groups"></div>
      <div class="count">좁혀지는 단위 <span class="tier high">지점 하나</span>높음 <span class="tier medium">몇 곳 / 동네</span>중간 <span class="tier">도시·구</span><span class="tier">국가·광역</span>낮음. 단서 하나만 보고 판정하고, 함께 보일 때의 위험은 조합으로 따로 적습니다.</div>
      <div class="count">단서를 누르면 그 단서의 상자만 켜고 끕니다. 마우스를 올리면 그 단서만 강조됩니다. <kbd>←</kbd> <kbd>→</kbd> 사진 이동, <kbd>A</kbd> 모두 켜기, <kbd>N</kbd> 모두 끄기</div>
    </div>
    <div class="clues" id="clues"></div>
  </div>
</main>
</div>
<script src="data.js"></script>
<script>
(()=>{
const DATA=window.VIEWER_DATA||{photos:[],colors:['#e6194b']};
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const color=n=>DATA.colors[(n-1)%DATA.colors.length];
const store={get(key,fallback){try{const value=localStorage.getItem('viewer.'+key);return value===null?fallback:JSON.parse(value);}catch{return fallback;}},set(key,value){try{localStorage.setItem('viewer.'+key,JSON.stringify(value));}catch{}}};
const options={text:store.get('text',true),object:store.get('object',true),hideBig:store.get('hideBig',true),all:store.get('all',false),mask:store.get('mask',true)};
// A mask arrives as run lengths (row by row, starting with 0s) over a small grid that covers the whole
// photo. It is painted once per mask and colour into a canvas and kept as an image the SVG stretches.
const maskImages=new Map();
function maskImage(mask,hex){
  const key=hex+':'+mask.size.join('x')+':'+mask.counts.join(',');
  if(maskImages.has(key))return maskImages.get(key);
  const [height,width]=mask.size,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d'),image=context.createImageData(width,height),r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  let at=0,on=false;
  for(const count of mask.counts){if(on)for(let i=at;i<at+count;i++){image.data[i*4]=r;image.data[i*4+1]=g;image.data[i*4+2]=b;image.data[i*4+3]=255;}at+=count;on=!on;}
  context.putImageData(image,0,0);
  const url=canvas.toDataURL('image/png');maskImages.set(key,url);return url;
}
const visible=new Map();   // photo id -> Set of clue numbers whose boxes are on
let filtered=[],current=null,hover=null;
// Reviews: what a person said about a clue. Kept by the local viewer server when the page is served
// by it (reviews.json), and in this browser otherwise; "내려받기" writes them to a file either way.
const QUESTIONS=[['box','상자 위치',[['right','맞음'],['partial','일부만'],['wrong','틀림']]],['category','범주',[['right','맞음'],['wrong','틀림']]],['risk','실제 위험',[['yes','위험함'],['no','아님'],['unsure','모르겠음']]]];
let reviews={};
const served=location.protocol==='http:'||location.protocol==='https:';
const keyOf=(photo,clue)=>photo.id+'/'+clue.id;
const asked=clue=>QUESTIONS.filter(([field])=>field!=='box'||clue.regions.length>0);
const isDone=(photo,clue)=>{const answer=reviews[keyOf(photo,clue)]||{};return asked(clue).every(([field])=>answer[field]);};
function progress(){
  let total=0,done=0;
  for(const photo of DATA.photos)for(const clue of photo.clues)if(clue.review){total++;if(isDone(photo,clue))done++;}
  const extra=Object.keys(reviews).filter(key=>QUESTIONS.some(([field])=>reviews[key][field])).length-done;
  $('progress').textContent='검토 '+done+' / '+total+' (확인된 위험 전부와 잠재 위험 표본)'+(extra>0?' · 그 밖에 '+extra+'개':'');
}
function note(text,bad){const el=$('saved');el.textContent=text;el.className='saved'+(bad?' bad':'');}
async function loadReviews(){
  if(served){try{const response=await fetch('reviews.json',{cache:'no-store'});if(response.ok){reviews=(await response.json()).reviews||{};note('서버에 저장됩니다');return;}}catch{}}
  reviews=store.get('reviews',{});note(served?'서버에 저장하지 못해 이 브라우저에만 저장합니다':'이 브라우저에만 저장됩니다. 내려받기로 파일을 남기세요',true);
}
async function saveReview(photo,clue,field,value){
  const key=keyOf(photo,clue),answer={...(reviews[key]||{})};
  if(answer[field]===value)delete answer[field];else answer[field]=value;
  answer.at=new Date().toISOString();reviews[key]=answer;
  store.set('reviews',reviews);
  if(served){
    try{
      const response=await fetch('reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,field,value:answer[field]??null})});
      note(response.ok?'저장됨':'서버 저장 실패. 이 브라우저에는 남아 있습니다',!response.ok);
    }catch{note('서버 저장 실패. 이 브라우저에는 남아 있습니다',true);}
  }
  progress();
}
const area=box=>(box[2]-box[0])*(box[3]-box[1]);
const drawn=clue=>clue.regions.filter(region=>(options.all||region.shown)&&(region.kind==='t'?options.text:options.object)&&!(options.hideBig&&area(region.bbox)>0.5));
const visibleSet=photo=>{if(!visible.has(photo.id))visible.set(photo.id,new Set(photo.clues.filter(clue=>clue.regions.length).map(clue=>clue.n)));return visible.get(photo.id);};

function fillFilters(){
  const folders=[...new Set(DATA.photos.map(photo=>photo.folder||'기타'))];
  $('fFolder').innerHTML='<option value="">폴더: 전체</option>'+folders.map(folder=>'<option>'+esc(folder)+'</option>').join('');
  const groups=new Map();
  for(const photo of DATA.photos)for(const clue of photo.clues)if(clue.taxonomy?.group)groups.set(clue.taxonomy.group,clue.taxonomy.groupKo);
  $('fGroup').innerHTML='<option value="">묶음: 전체</option>'+[...groups].map(([group,ko])=>'<option value="'+esc(group)+'">'+esc(ko)+' 단서가 있는 사진</option>').join('');
}
// The highest risk in a photo, over its clues and its combinations.
const LEVELS=['high','medium','low'],levels=new Set(LEVELS);
const RISK_KO={high:'높음',medium:'중간',low:'낮음'},UNIT_KO={point:'지점 하나',few:'몇 곳 / 동네',city:'도시·구',country:'국가·광역'},CLASS_KO={identifier:'고유 식별자',structure:'독특한 구조물',chain:'체인·반복 브랜드',view:'조망·주변 맥락',regional:'지역 공통 양식',nature:'자연환경',other:'기타'};
function topRisk(photo){const all=[...photo.clues.map(clue=>clue.rule.risk),...photo.combinations.map(combo=>combo.risk)];return all.includes('high')?'high':all.includes('medium')?'medium':'low';}
function applyFilters(){
  const folder=$('fFolder').value,risk=$('fRisk').value,warn=$('fWarn').value,guess=$('fGuess').value,group=$('fGroup').value,linked=$('fLinked').checked,onlyPick=$('fPick').checked,onlyReview=$('fReview').checked,onlyTodo=$('fTodo').checked,query=$('fSearch').value.trim().toLowerCase();
  filtered=DATA.photos.filter(photo=>{
    if(folder&&(photo.folder||'기타')!==folder)return false;
    if(linked&&!photo.boxes)return false;
    if(onlyPick&&!photo.pick)return false;
    if(onlyReview&&!photo.clues.some(clue=>clue.review))return false;
    if(onlyTodo&&!photo.clues.some(clue=>clue.review&&!isDone(photo,clue)))return false;
    const top=topRisk(photo);
    if((risk==='high'||risk==='medium')&&top!==risk)return false;
    if(risk==='none'&&top!=='low')return false;
    if(risk==='combo'&&!photo.combinations.length)return false;
    if(risk==='confirmed'&&!photo.measured.confirmed)return false;
    if(risk==='unjudged'&&photo.risk.judged)return false;
    if(risk==='unsearched'&&photo.measured.searched)return false;
    if(warn==='any'&&!photo.warning)return false;
    if((warn==='scene'||warn==='text')&&photo.warning?.kind!==warn)return false;
    if(warn==='none'&&photo.warning)return false;
    if(guess==='hit'&&!photo.guess?.hit)return false;
    if(guess==='miss'&&(!photo.guess||photo.guess.hit))return false;
    if(guess==='none'&&photo.guess)return false;
    if(group&&!photo.clues.some(clue=>clue.taxonomy?.group===group))return false;
    if(query&&!photo.clues.some(clue=>[clue.ko,clue.en,clue.category,clue.taxonomy?.ko,clue.taxonomy?.name].some(text=>String(text||'').toLowerCase().includes(query))))return false;
    return true;
  });
  $('count').textContent='사진 '+filtered.length+'장 / 전체 '+DATA.photos.length+'장';
  let last=null;
  $('list').innerHTML=filtered.map(photo=>{
    const head=(photo.folder||'기타')!==last?'<div class="folder">'+esc(last=photo.folder||'기타')+'</div>':'';
    const dot=photo.guess?'<span class="dot '+(photo.guess.hit?'hit':'miss')+'" title="'+esc(photo.guess.text)+'"></span>':'<span class="dot" title="주소 추정 없음"></span>';
    return head+'<button class="item'+(current&&photo.id===current.id?' on':'')+'" data-id="'+photo.id+'">'+dot+esc(photo.title)+(photo.pick?'<span class="flag pick">확인 '+photo.pick.order+'</span>':'')+(photo.warning?'<span class="flag'+(photo.warning.kind==='scene'?'':' also')+'" title="'+esc(photo.warning.title)+'">사진 경고</span>':'')+'<span class="meta">'+(photo.risk.high?'높음 '+photo.risk.high+' · ':'')+(photo.risk.medium?'중간 '+photo.risk.medium+' · ':'')+(photo.combinations.length?'조합 '+photo.combinations.length+' · ':'')+'단서 '+photo.clues.length+' · '+(photo.linked?'상자 '+photo.boxes:'상자 없음')+'</span></button>';
  }).join('')||'<div class="empty">조건에 맞는 사진이 없습니다.</div>';
  // The position counter and the previous/next buttons depend on the filtered list, so redraw either way.
  show(current&&filtered.some(photo=>photo.id===current.id)?current:filtered[0]||null,true);
}
function show(photo,keepScroll=false){
  current=photo;hover=null;
  for(const item of document.querySelectorAll('.item'))item.classList.toggle('on',Boolean(photo)&&item.dataset.id===photo.id);
  if(!photo){$('stage').innerHTML='<div class="empty">사진을 고르세요.</div>';$('clues').innerHTML='';$('groups').innerHTML='';return;}
  const index=filtered.findIndex(candidate=>candidate.id===photo.id);
  const guess=photo.guess?'<div class="guess'+(photo.guess.hit?' hit':'')+'"><strong>주소 추정</strong> · '+esc(photo.guess.text)+(DATA.internal?'<br>모델이 낸 답 (내부 평가용): '+(photo.guess.addresses.map(address=>'<code>'+esc(address)+'</code>').join(' ')||'없음'):'')+'</div>':'<div class="guess">주소 추정을 하지 않은 사진입니다.</div>';
  $('stage').innerHTML='<div class="head"><button class="nav" id="prev"'+(index<=0?' disabled':'')+'>← 이전</button><h2>'+esc(photo.title)+'</h2><span class="count">'+(index+1)+' / '+filtered.length+'</span><button class="nav" id="next"'+(index>=filtered.length-1?' disabled':'')+'>다음 →</button></div>'+
    (photo.pick?'<div class="pick"><strong>확인 부탁 '+photo.pick.order+'</strong> · '+esc(photo.pick.ask)+'</div>':'')+
    (photo.warning?'<div class="warn'+(photo.warning.kind==='scene'?' scene':'')+'" id="warning"><strong>사진 경고 · '+esc(photo.warning.title)+'</strong><br>'+esc(photo.warning.text)+'</div>':'')+
    '<div class="imgwrap"><img alt="'+esc(photo.title)+'" src="'+esc(photo.image)+'"><svg id="svg" viewBox="0 0 '+photo.width+' '+photo.height+'" preserveAspectRatio="none"></svg></div>'+
    guess+'<div class="guess'+(topRisk(photo)==='high'?' hit':'')+'"><strong>위험도</strong> · 높음 '+photo.risk.high+' · 중간 '+photo.risk.medium+' · 낮음 '+photo.risk.low+(photo.risk.judged?'':'<br>규칙에 따른 단서별 판정을 하지 않은 사진입니다. 범주 기본값으로 표시합니다.')+
      photo.combinations.map(combo=>'<br><span class="label '+combo.risk+'" style="margin-left:0">조합 '+RISK_KO[combo.risk]+'</span> '+esc(combo.type==='guess'?'주소 추정 적중':combo.type)+' · 단서 '+combo.clueNs.join(' + ')+' → '+UNIT_KO[combo.unit]+' · '+esc(combo.reason)+(combo.supportingNs&&combo.supportingNs.length?' 함께 든 단서 '+combo.supportingNs.join(', ')+'번은 혼자서는 위치가 나오지 않아 등급을 유지합니다.':'')).join('')+
      '<br><span class="rule">'+(photo.measured.searched?'지도 검색으로 확인된 단서 '+photo.measured.confirmed+'개. 조합 검색 '+photo.measured.combinations+'회 중 '+photo.measured.revealingCombinations+'회에서 실제 위치가 나왔습니다.':'촬영 위치가 없는 사진이라 지도 검색으로 확인하지 못했습니다.')+'</span></div>'+
    '<p class="info">'+(photo.linked?'':'이 사진은 영역 연결을 하지 않아 상자가 없습니다. ')+'기록 '+esc(photo.id)+'</p>';
  $('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);
  $('svg').onclick=event=>{const n=event.target.dataset?.n;if(n)flash(Number(n));};
  renderLevels();renderGroups();renderClues();renderBoxes();
  if(!keepScroll)document.querySelector('.item.on')?.scrollIntoView({block:'nearest'});
}
function step(delta){const index=filtered.findIndex(photo=>photo.id===current?.id)+delta;if(index>=0&&index<filtered.length)show(filtered[index]);}
function renderGroups(){
  const on=visibleSet(current),groups=new Map();
  for(const clue of current.clues)if(clue.regions.length){const key=clue.taxonomy?.group||'';const entry=groups.get(key)||{ko:clue.taxonomy?.groupKo||'분류 없음',clues:[]};entry.clues.push(clue.n);groups.set(key,entry);}
  $('groups').innerHTML=[...groups].map(([group,entry])=>'<button class="btn'+(entry.clues.some(n=>on.has(n))?'':' off')+'" data-group="'+esc(group)+'">'+esc(entry.ko)+' '+entry.clues.length+'</button>').join('');
  for(const button of $('groups').querySelectorAll('button'))button.onclick=()=>{
    const numbers=current.clues.filter(clue=>clue.regions.length&&(clue.taxonomy?.group||'')===button.dataset.group).map(clue=>clue.n),anyOn=numbers.some(n=>on.has(n));
    for(const n of numbers)anyOn?on.delete(n):on.add(n);
    renderGroups();renderClues();renderBoxes();
  };
}
function renderLevels(){
  $('levels').innerHTML='<span class="count">위험도별 보기</span>'+LEVELS.map(level=>'<button class="btn '+level+(levels.has(level)?'':' off')+'" data-level="'+level+'">'+RISK_KO[level]+' '+current.clues.filter(clue=>clue.rule.risk===level).length+'</button>').join('');
  for(const button of $('levels').querySelectorAll('button'))button.onclick=()=>{const level=button.dataset.level;levels.has(level)?levels.delete(level):levels.add(level);renderLevels();renderClues();renderBoxes();};
}
// The list is grouped by risk, high first; within a level the clues keep their numbers and order.
function renderClues(){
  const on=visibleSet(current);
  $('clues').innerHTML=LEVELS.filter(level=>levels.has(level)).map(level=>{const rows=current.clues.filter(clue=>clue.rule.risk===level);return rows.length?'<div class="level '+level+'">'+RISK_KO[level]+' '+rows.length+'</div>'+rows.map(clueRow(on)).join(''):'';}).join('')||'<div class="empty">표시할 위험도를 고르세요.</div>';
  bindClues();
}
const clueRow=on=>clue=>{
    const has=clue.regions.length>0,count=drawn(clue).length,total=clue.regions.length;
    const targets=[...clue.textTargets.map(text=>'글자 <code>'+esc(text)+'</code>'),...clue.objectTargets.map(text=>'물체 <code>'+esc(text)+'</code>')].join(' · ');
    return '<div class="clue'+(has?(on.has(clue.n)?'':' off'):' nobox')+'" data-n="'+clue.n+'"><div><span class="chip" style="background:'+color(clue.n)+';border-color:'+color(clue.n)+'">'+clue.n+'</span></div><div class="body">'+
      '<div><span class="tier '+clue.rule.risk+'">'+UNIT_KO[clue.rule.unit]+'</span><span class="cat">'+esc(clue.taxonomy?clue.taxonomy.ko:clue.category)+'</span> <span class="tax">'+esc(clue.taxonomy?.groupKo||'')+' · '+esc(clue.category)+'</span><span class="label '+clue.rule.risk+'">'+RISK_KO[clue.rule.risk]+'</span>'+(clue.combinations.length?'<span class="label '+current.combinations.find(combo=>combo.id===clue.combinations[0]).risk+'" title="다른 단서와 함께 보일 때의 위험">조합</span>':'')+(clue.confirmed?'<span class="label measured" title="지도 검색으로 실제 위치가 나옴">검색 확인</span>':'')+(clue.review?'<span class="todo'+(isDone(current,clue)?' done':'')+'">'+(isDone(current,clue)?'검토함':'검토 대상')+'</span>':'')+'</div>'+
      '<div class="ko">'+esc(clue.ko||clue.en)+'</div>'+'<div class="rule">'+[CLASS_KO[clue.rule.class],clue.rule.situation,clue.rule.basis].filter(Boolean).map(esc).join(' · ')+'</div>'+clue.evidence.map(text=>'<div class="proof">'+esc(text)+'</div>').join('')+
      '<div class="small">'+(clue.quotes&&!clue.located&&clue.rule.risk!=='low'?'<strong>인용한 글자를 사진에서 찾지 못했습니다.</strong> ':'')+(clue.quotes&&clue.locatedBy==='ocr'?'<strong>찾음</strong> (OCR이 읽은 글자) · ':clue.locatedBy==='model'?'<strong>대체돼서 찾음</strong> ('+(clue.quotes?'OCR이 못 읽어':'검출기가 못 찾아')+' 모델이 짚은 상자로 대체) · ':'')+(has?'상자 '+count+'개 표시 (후보 '+total+'개)':(!current.linked?'영역 연결 안 함':clue.localization==='not_searched'?'찾지 않음':'찾았으나 영역 없음'))+'</div>'+
      (clue.review?'':'<details class="extra"'+(reviews[keyOf(current,clue)]&&asked(clue).some(([field])=>reviews[keyOf(current,clue)][field])?' open':'')+'><summary>이 단서도 검토</summary>')+('<div class="review" data-n="'+clue.n+'">'+asked(clue).map(([field,title,choices])=>'<div class="q"><span>'+title+'</span>'+choices.map(([value,text])=>'<button data-field="'+field+'" data-value="'+value+'" class="'+((reviews[keyOf(current,clue)]||{})[field]===value?'on':'')+'">'+text+'</button>').join('')+'</div>').join('')+'</div>')+(clue.review?'':'</details>')+
      '<details><summary>원문과 검출 대상</summary><p class="en">'+esc(clue.en)+'</p>'+(targets?'<p class="en">'+targets+'</p>':'')+(clue.taxonomy?'<p class="en">범주 '+clue.taxonomy.number+'. '+esc(clue.taxonomy.name)+'</p>':'')+'</details></div></div>';
};
function bindClues(){
  for(const row of $('clues').querySelectorAll('.clue')){
    const n=Number(row.dataset.n);
    row.onmouseenter=()=>{hover=n;renderBoxes();};row.onmouseleave=()=>{hover=null;renderBoxes();};
    for(const button of row.querySelectorAll('.review button'))button.onclick=async event=>{
      event.stopPropagation();
      const clue=current.clues.find(candidate=>candidate.n===n);
      await saveReview(current,clue,button.dataset.field,button.dataset.value);
      const top=$('clues').scrollTop;renderClues();$('clues').scrollTop=top;
    };
    row.onclick=event=>{if(event.target.closest('details')||event.target.closest('.review')||event.target.closest('summary')||row.classList.contains('nobox'))return;on.has(n)?on.delete(n):on.add(n);row.classList.toggle('off',!on.has(n));renderGroups();renderBoxes();};
  }
}
function renderBoxes(){
  const svg=$('svg');if(!svg||!current)return;
  const on=visibleSet(current),W=current.width,H=current.height,font=Math.max(11,Math.round(Math.max(W,H)/55)),parts=[];
  // The same box is often given to several clues (three clues about one ad panel). It is drawn once,
  // labelled with all their numbers.
  const groups=new Map();
  for(const clue of current.clues){
    if(!levels.has(clue.rule.risk)||(!on.has(clue.n)&&hover!==clue.n))continue;
    for(const region of drawn(clue)){
      const key=region.kind+':'+region.bbox.map(value=>value.toFixed(2)).join(',');
      if(!groups.has(key))groups.set(key,{region,clues:[]});
      groups.get(key).clues.push(clue);
    }
  }
  for(const {region,clues} of groups.values()){
    const clue=clues.find(entry=>entry.n===hover)||clues[0];
    const dim=hover!==null&&!clues.some(entry=>entry.n===hover),strong=clues.some(entry=>entry.n===hover);
    {
      const [x0,y0,x1,y1]=region.bbox,x=x0*W,y=y0*H,w=Math.max(2,(x1-x0)*W),h=Math.max(2,(y1-y0)*H),c=color(clue.n),label=clues.map(entry=>entry.n).join('·'),lw=font*(0.5+0.62*label.length),ly=y>=font*1.3?y-font*1.3:y;
      const title='<title>'+esc(label+'. '+(clue.taxonomy?.ko||clue.category)+' — '+(region.standIn&&region.kind==='o'?'물체 (검출기가 못 찾아 모델 상자로 대체) ':region.standIn?'글자 (모델 상자로 대체, OCR 확인 안 됨) ':region.kind==='t'?'글자 ':region.kind==='p'?'':'물체 ')+(region.label||'')+(region.score!==null?' ('+region.score+')':''))+'</title>';
      // An OCR line is drawn along its own outline; everything else as its box. The label stays at the box corner.
      const points=region.polygon?region.polygon.map(point=>(point[0]*W)+','+(point[1]*H)).join(' '):null;
      const shape=(attrs,inner)=>points?'<polygon points="'+points+'" stroke-linejoin="round"'+attrs+'>'+inner+'</polygon>':'<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"'+attrs+'>'+inner+'</rect>';
      // A region with a mask is shown by its mask alone (owner's decision of 2026-11-18): the box outline is
      // not drawn. The box itself stays in place, invisible, so that hovering and clicking still work, and
      // comes back when masks are switched off.
      const painted=options.mask&&region.mask?'<image href="'+maskImage(region.mask,c)+'" x="0" y="0" width="'+W+'" height="'+H+'" preserveAspectRatio="none" opacity="'+(strong?0.62:0.45)+'" pointer-events="none"/>':'';
      parts.push('<g opacity="'+(dim?0.12:1)+'">'+painted+
        (painted?'':shape(' fill="'+(strong?c:'none')+'" fill-opacity="0.14" stroke="#fff" stroke-width="'+(strong?6:4)+'" stroke-opacity="0.85" vector-effect="non-scaling-stroke"',''))+
        shape(' class="box" data-n="'+clue.n+'" fill="transparent" stroke="'+(painted?'none':c)+'" stroke-width="'+(strong?3.5:2)+'"'+(region.standIn?' stroke-dasharray="12 5"':region.kind==='o'?' stroke-dasharray="7 4"':region.kind==='p'?' stroke-dasharray="16 6 3 6"':'')+' vector-effect="non-scaling-stroke"',title)+
        '<rect x="'+x+'" y="'+ly+'" width="'+lw+'" height="'+font*1.3+'" fill="'+c+'"/><text x="'+(x+font*0.25)+'" y="'+(ly+font)+'" fill="#fff" font-size="'+font+'" font-weight="bold" font-family="Arial, sans-serif">'+label+'</text></g>');
    }
  }
  svg.innerHTML=parts.join('');
}
function flash(n){const row=$('clues').querySelector('.clue[data-n="'+n+'"]');if(!row)return;row.scrollIntoView({block:'center',behavior:'smooth'});row.classList.add('flash');setTimeout(()=>row.classList.remove('flash'),900);}
function setAll(state){if(!current)return;const on=visibleSet(current);on.clear();if(state)for(const clue of current.clues)if(clue.regions.length)on.add(clue.n);renderGroups();renderClues();renderBoxes();}

for(const [id,key] of [['oText','text'],['oObject','object'],['oBig','hideBig'],['oAll','all'],['oMask','mask']]){
  $(id).checked=options[key];
  $(id).onchange=()=>{options[key]=$(id).checked;store.set(key,options[key]);if(current){renderClues();renderBoxes();}};
}
$('allOn').onclick=()=>setAll(true);$('allOff').onclick=()=>setAll(false);
$('riskOn').onclick=()=>{if(!current)return;const on=visibleSet(current);on.clear();for(const clue of current.clues)if(clue.regions.length&&(clue.rule.risk!=='low'||clue.combinations.length||clue.confirmed))on.add(clue.n);renderGroups();renderClues();renderBoxes();};
for(const id of ['fPick','fFolder','fRisk','fWarn','fGuess','fGroup','fLinked','fReview','fTodo'])$(id).onchange=applyFilters;
$('fSearch').oninput=applyFilters;
$('list').onclick=event=>{const item=event.target.closest('.item');if(item)show(DATA.photos.find(photo=>photo.id===item.dataset.id));};
document.addEventListener('keydown',event=>{
  if(event.target.matches('input[type=search],select,textarea'))return;
  if(event.key==='ArrowRight')step(1);else if(event.key==='ArrowLeft')step(-1);else if(event.key==='a'||event.key==='A')setAll(true);else if(event.key==='n'||event.key==='N')setAll(false);
});
$('exportReviews').onclick=()=>{
  const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),reviews},null,1)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='clue-reviews.json';link.click();URL.revokeObjectURL(link.href);
};
fillFilters();
loadReviews().then(()=>{progress();applyFilters();});
})();
</script>
</body></html>
`;
