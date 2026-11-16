import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { sharp } from '../lib/config.mjs';
import { quotedStrings,matchText,parseTargets,boundsOf,linkRegions,regionTargetPrompt,REGION_TARGET_TEMPLATE } from '../lib/paper-regions.mjs';
import { displayRegions,overlaySvg,renderOverlay,buildPreviewHtml } from '../lib/paper-preview.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { handoffLlm,pendingHandoffs } from '../lib/paper-handoff.mjs';
import { regionStage } from '../lib/paper-llm.mjs';
import { linkRunRegions,toolCopy } from '../lib/paper-runner.mjs';

const fence='```';
const square=(x,y,size=0.1)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size]];
const clues=[
  {id:'clue-0',category:'Sign Text',detail:'Awning reads "ROOT HAUS"; a poster says \'OPENING HOUR\'.',taxonomy:null},
  {id:'clue-1',category:'Fire Safety',detail:'Red fire extinguisher inside the door.',taxonomy:null},
  {id:'clue-2',category:'Season',detail:'Bare trees suggest winter.',taxonomy:null},
];
const targetsAnswer=`${fence}json\n{"clue-0": ["Storefront Awning Sign."], "clue-1": ["red fire extinguisher", "glass door"], "clue-2": []}\n${fence}`;
const ocrResult={engine:'PaddleOCR',version:'fixture',lines:[
  {id:'ocr-0',text:'POOT HAUS',score:.8,polygon:square(.1,.1,.4)},{id:'ocr-1',text:'OPENING HOUR',score:.9,polygon:square(.3,.6)},{id:'ocr-2',text:'08:00',score:.9,polygon:square(.3,.7)}]};
const detectFake=calls=>async(bytes,queries)=>{calls.push(queries);return {engine:'Grounding DINO',model:'fixture',revision:'r',requests:queries.map(q=>({...q,detections:
  q.query==='glass door'?[{id:'a',bbox:[0,0,1,.95],score:.9,label:'door'},{id:'b',bbox:[.1,.4,.6,.9],score:.5,label:'door'}]
  :q.query==='red fire extinguisher'?[{id:'c',bbox:[.4,.8,.5,.9],score:.4,label:'x'},{id:'d',bbox:[.41,.8,.5,.9],score:.93,label:'x'},{id:'e',bbox:[.7,.1,.8,.2],score:.31,label:'x'},{id:'f',bbox:[.2,.2,.3,.3],score:.3,label:'x'}]
  :[{id:'g',bbox:[0,.05,1,.4],score:.52,label:'sign'}]}))};};

test('quoted strings, text matching and target parsing',()=>{
  assert.deepEqual(quotedStrings('Reads "ROOT HAUS" and “루트하우스”; heading \'중앙여자대학으로 승격\'. Women\'s College and the university\'s logo. "ROOT HAUS" again.'),['ROOT HAUS','루트하우스','중앙여자대학으로 승격']);
  assert.deepEqual(quotedStrings('No quotes here.'),[]);
  // A misread stretch of a longer quote, in either direction; not short words, not unrelated text.
  assert.equal(matchText('MAPO HANGANG PRUGIO','MAPO KANGANG'),'line_near_quote_part');
  assert.equal(matchText('DEPOUND','DEROUND WTM'),'quote_near_line_part');
  assert.equal(matchText('마포대교 (여의도한강공원)','(여의도환강공원)'),'line_near_quote_part');
  assert.equal(matchText('MAPO HANGANG PRUGIO','MARIO'),null);assert.equal(matchText('MAPO HANGANG PRUGIO','SEOUL STATION'),null);
  assert.equal(matchText('ROOT HAUS','ROOTHAUS'),'exact');assert.equal(matchText('ROOT HAUS','POOT HAUS'),'fuzzy');
  assert.equal(matchText('MATCHA CHOCO SALT BREAD','MATCHA CHOCO'),'line_in_quote');assert.equal(matchText('서서울미술관','서울시립 서서울미술관'),'quote_in_line');
  assert.equal(matchText('새로운 카페 와보기','카페'),'line_in_quote');assert.equal(matchText('OPENING HOUR','UL'),null);assert.equal(matchText('ROOT HAUS','SWEET POTATO'),null);assert.equal(matchText('"',' '),null);
  assert.deepEqual(boundsOf(square(.1,.2,.3)).map(v=>+v.toFixed(2)),[.1,.2,.4,.5]);

  const ids=['clue-0','clue-1','clue-2'];
  assert.deepEqual(parseTargets(targetsAnswer,ids),{'clue-0':['storefront awning sign'],'clue-1':['red fire extinguisher','glass door'],'clue-2':[]});
  assert.deepEqual(parseTargets('{"clue-1": ["a b c","a b c","d e f","g h i","j k l","m n o"]}',ids),{'clue-0':[],'clue-1':['a b c','d e f','g h i','j k l'],'clue-2':[]});
  assert.throws(()=>parseTargets('{"clue-9": []}',ids),/REGION_TARGETS_UNKNOWN_CLUE/);
  assert.throws(()=>parseTargets('{"clue-0": "sign"}',ids),/REGION_TARGETS_INVALID/);assert.throws(()=>parseTargets('no json',ids),/REGION_TARGETS_INVALID/);
  // The model sees the clue text only: id, category and detail, nothing else from the record.
  const prompt=regionTargetPrompt(clues);
  assert.ok(prompt.includes('"detail": "Red fire extinguisher inside the door."'));assert.ok(!prompt.includes('taxonomy'));assert.ok(!prompt.includes('<<CLUES>>'));assert.ok(REGION_TARGET_TEMPLATE.includes('You do not see the photograph'));
});

test('linkRegions takes text boxes from OCR and object boxes from the detector, never from the model',async()=>{
  const detectCalls=[],llmCalls=[];let ocrCalls=0;
  const llm=async call=>{llmCalls.push(call);return {text:targetsAnswer,raw:{responseId:'r'}};};
  const result=await linkRegions({bytes:Buffer.from('i'),clues,model:'m',llm,ocr:async()=>{ocrCalls++;return ocrResult;},detect:detectFake(detectCalls)});
  assert.equal(llmCalls.length,1);assert.equal(llmCalls[0].imageBytes,undefined);assert.equal(ocrCalls,1);
  // One query per distinct phrase.
  assert.deepEqual(detectCalls.flat().map(q=>q.query),['storefront awning sign','red fire extinguisher','glass door']);
  const [sign,fire,season]=result.clues;
  assert.deepEqual(sign.textTargets,['ROOT HAUS','OPENING HOUR']);assert.deepEqual(sign.objectTargets,['storefront awning sign']);
  assert.deepEqual(sign.regions.map(r=>[r.kind,r.source,r.kind==='text'?r.match:r.query]),[['text','paddleocr','fuzzy'],['text','paddleocr','exact'],['object','grounding_dino','storefront awning sign']]);
  assert.deepEqual(sign.regions[0].bbox.map(v=>+v.toFixed(2)),[.1,.1,.5,.5]);assert.equal(sign.regions[0].text,'POOT HAUS');assert.equal(sign.regions[0].quoted,'ROOT HAUS');
  // Top three boxes per phrase by score; a box covering most of the image is dropped.
  assert.deepEqual(fire.regions.map(r=>[r.query,r.score]),[['red fire extinguisher',.93],['red fire extinguisher',.4],['red fire extinguisher',.31],['glass door',.5]]);
  assert.equal(result.summary.detection.droppedLargeBoxes,1);
  assert.deepEqual([sign.localization,fire.localization,season.localization],['proposed','proposed','unlocalized']);assert.deepEqual(season.regions,[]);
  assert.deepEqual([result.summary.ocr.lineCount,result.summary.ocr.linkedLineCount,result.summary.detection.queryCount,result.summary.verification],[3,2,3,'none']);
  assert.deepEqual(result.summary.ocr.lines.map(l=>l.linked),[true,true,false]);assert.equal(fire.taxonomy,null);

  // The model step comes first: if it has no answer yet, no tool has run.
  let touched=0;
  await assert.rejects(linkRegions({bytes:Buffer.from('i'),clues,model:'m',llm:async()=>{throw new Error('HANDOFF_PENDING');},ocr:async()=>{touched++;},detect:async()=>{touched++;}}),/HANDOFF_PENDING/);
  assert.equal(touched,0);
  // An unusable answer is asked for again, then given up on.
  const retry=[];
  await assert.rejects(linkRegions({bytes:Buffer.from('i'),clues,model:'m',llm:async call=>{retry.push(call.attempt);return {text:'nope',raw:{}};},ocr:async()=>ocrResult,detect:detectFake([])}),/REGION_TARGETS_INVALID/);
  assert.deepEqual(retry,[1,2]);
});

test('runner parks region linking on a hand-off, then stores regions on the same record',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-regions-'));
  try{
    const store=new PaperStore(directory);const stage=regionStage({},{handoffModel:'stand-in'});const llm=handoffLlm(store.handoffDirectory);
    assert.deepEqual([stage.model,stage.transport,stage.matchesPaper,stage.paperModel],['stand-in','handoff',null,null]);
    assert.deepEqual([regionStage({OPENAI_MODEL:'current'}).model,regionStage({OPENAI_MODEL:'current',PAPER_REGION_MODEL:'other'}).model,regionStage({}).model],['current','other',null]);
    const run=store.createRun({width:10,height:10,sha256:'s'},Buffer.from('i'),{});
    run.status='extracted';run.clues=structuredClone(clues);store.saveRun(run);
    const seenByTools=[];
    const tools={ocr:async bytes=>{seenByTools.push(bytes.toString());return ocrResult;},detect:detectFake([]),prepare:async bytes=>({bytes:Buffer.from(`${bytes}-small`),width:5,height:5,resized:true})};
    const parked=await linkRunRegions({store,run:store.getRun(run.id),stage,llm,...tools});
    assert.equal(parked.pending.stage,'regionTargets');assert.equal(parked.regions,undefined);assert.deepEqual(parked.errors,[]);assert.equal(parked.status,'extracted');
    writeFileSync(resolve(pendingHandoffs(store.handoffDirectory)[0].directory,'response.txt'),targetsAnswer);
    const linked=await linkRunRegions({store,run:store.getRun(run.id),stage,llm,...tools});
    assert.equal(linked.pending,undefined);assert.equal(linked.regions.version,'paper-regions-v1');assert.equal(linked.regions.stage.transport,'handoff');
    // The tools work on the prepared copy; its size is on record.
    assert.deepEqual(seenByTools,['i-small']);assert.deepEqual(linked.regions.toolImage,{width:5,height:5,resized:true,maxSide:2000});
    assert.deepEqual(linked.clues.map(c=>c.regions.length),[3,4,0]);assert.deepEqual(linked.modelCalls.map(c=>[c.stage,c.attempt]),[['regionTargets',1]]);
    // Linking again replaces the regions instead of stacking them, and a tool failure is recorded by code.
    const again=await linkRunRegions({store,run:store.getRun(run.id),stage,llm,...tools});
    assert.deepEqual(again.clues.map(c=>c.regions.length),[3,4,0]);assert.equal(again.modelCalls.length,1);
    const broken=await linkRunRegions({store,run:store.getRun(run.id),stage,llm,...tools,ocr:async()=>{throw new Error('OCR_FAILED');}});
    assert.deepEqual(broken.errors.map(e=>[e.stage,e.code]),[['regions','OCR_FAILED']]);assert.deepEqual(broken.clues.map(c=>c.regions.length),[3,4,0]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('tools get a copy no larger than 2000 px on its longer side',async()=>{
  const large=await sharp({create:{width:2304,height:3072,channels:3,background:'#777777'}}).jpeg().toBuffer();
  const small=await sharp({create:{width:1125,height:2000,channels:3,background:'#777777'}}).jpeg().toBuffer();
  const reduced=await toolCopy(large);
  assert.deepEqual([reduced.width,reduced.height,reduced.resized],[1500,2000,true]);
  const meta=await sharp(reduced.bytes).metadata();assert.deepEqual([meta.width,meta.height,meta.format],[1500,2000,'jpeg']);
  const kept=await toolCopy(small);
  assert.deepEqual([kept.width,kept.height,kept.resized],[1125,2000,false]);assert.equal(kept.bytes,small);
});

test('preview draws one box per place and escapes everything it prints',async()=>{
  const clue={id:'clue-0',category:'Sign <Text>',detail:'Reads "A&B"',textTargets:['A&B'],objectTargets:['glass door','lamp'],regions:[
    {kind:'text',match:'fuzzy',quoted:'A&B',text:'A8B',bbox:[.1,.1,.3,.2]},{kind:'text',match:'exact',quoted:'A&B',text:'A&B',bbox:[.1,.1,.3,.21]},
    {kind:'object',query:'glass door',score:.5,bbox:[.4,.4,.8,.9]},{kind:'object',query:'glass door',score:.9,bbox:[.1,.5,.3,.9]},{kind:'object',query:'lamp',score:.3,bbox:[.6,.1,.7,.2]}]};
  // Duplicate text reads collapse to the best match; one box per phrase; weak boxes are not drawn.
  assert.deepEqual(displayRegions(clue).map(r=>[r.kind,r.match??r.score]),[['text','exact'],['object',.9]]);
  assert.deepEqual(displayRegions({regions:[]}),[]);assert.deepEqual(displayRegions({}),[]);
  const svg=overlaySvg([clue,{...clue,regions:[]}],200,100);
  assert.equal((svg.match(/stroke-dasharray/g)||[]).length,1);assert.equal((svg.match(/<text /g)||[]).length,2);assert.ok(svg.includes('x="20.0" y="10.0"'));
  const photo=await sharp({create:{width:400,height:200,channels:3,background:'#888888'}}).jpeg().toBuffer();
  const overlay=await renderOverlay(photo,[clue],200);
  const meta=await sharp(overlay).metadata();assert.deepEqual([meta.format,meta.width,meta.height],['jpeg',200,100]);
  const run={id:'run-1',stages:{detector:{model:'m',transport:'handoff'}},clues:[clue,{id:'clue-1',category:'Season',detail:'Winter',regions:[]}]};
  const html=buildPreviewHtml([{run,overlay,korean:{'clue-0':'[위치 추정] 간판 <b>'}}],{generatedAt:'now'});
  assert.ok(html.includes('Sign &lt;Text&gt;'));assert.ok(html.includes('<span class="guess">위치 추정</span> 간판 &lt;b&gt;'));assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('글자 영역 1개 · 물체 영역 1개'));assert.ok(html.includes('영역 없음'));assert.ok(html.includes('data:image/jpeg;base64,'));assert.ok(html.includes('영역이 붙은 단서 1개'));
  assert.ok(html.includes('<code>A&amp;B</code>'));assert.ok(html.includes('<code>lamp</code> (0.30)'));
});

test('with the tier policy, detection runs for tier A only and OCR matching for tiers A and B', async () => {
  const { TIERED_POLICY, tierForLinking, riskTierOf, RISK_TIERS } = await import('../lib/paper-risk-tiers.mjs');
  const { figure25Categories } = await import('../lib/paper-taxonomy-figure25.mjs');
  const { MINED_GROUP_OF } = await import('../lib/paper-taxonomy-mined-labels.mjs');
  // Every one of the 84 categories has exactly one tier.
  const names = [...figure25Categories().map(category => category.name), ...Object.keys(MINED_GROUP_OF)];
  assert.equal(names.length, 84);
  assert.deepEqual(names.filter(name => !riskTierOf(name)), []);
  assert.equal(Object.values(RISK_TIERS).reduce((sum, tier) => sum + Object.keys(tier).length, 0), 84);
  assert.deepEqual([riskTierOf('Commercial Signage'), riskTierOf('Media Overlay Content'), riskTierOf('Climate Indicators'), riskTierOf('No Such Category')], ['A', 'B', 'C', null]);
  // A clue without a known category is searched like tier A.
  assert.equal(tierForLinking({ taxonomy: null }), 'A');

  const tiered = [
    { id: 'clue-0', category: 'Sign', detail: 'Awning reads "ROOT HAUS".', taxonomy: { number: 11, name: 'Commercial Signage' } },
    { id: 'clue-1', category: 'Caption', detail: 'Overlay caption says "OPENING HOUR".', taxonomy: { number: 33, name: 'Media Overlay Content' } },
    { id: 'clue-2', category: 'Season', detail: 'A banner reads "ROOT HAUS" under bare trees.', taxonomy: { number: 8, name: 'Climate Indicators' } },
    { id: 'clue-3', category: 'Landmark', detail: 'A domed hall with a clock tower.', taxonomy: { number: 20, name: 'Community Features' } },
  ];
  const answer = `${fence}json\n{"clue-0": ["awning sign", "glass door", "menu poster"], "clue-1": ["caption text"], "clue-2": ["bare tree"], "clue-3": ["domed hall", "clock tower", "flag pole"]}\n${fence}`;
  const asked = [];
  const detect = async (bytes, queries) => { asked.push(...queries.map(query => query.query)); return { engine: 'Grounding DINO', model: 'fixture', revision: 'r', requests: queries.map(query => ({ cueId: query.cueId, query: query.query, detections: [{ id: `d-${query.cueId}`, bbox: [0.1, 0.1, 0.3, 0.3], score: 0.6, label: query.query }] })) }; };
  const result = await linkRegions({ bytes: Buffer.from('i'), clues: tiered, model: 'm', llm: async () => ({ text: answer, raw: {} }), ocr: async () => ocrResult, detect, policy: TIERED_POLICY, tierOf: tierForLinking });
  // Only a tier A clue that quotes no text reaches the detector, with two phrases at most.
  assert.deepEqual(asked, ['domed hall', 'clock tower']);
  const [signage, caption, season, landmark] = result.clues;
  assert.deepEqual([signage.risk.tier, caption.risk.tier, season.risk.tier], ['A', 'B', 'C']);
  // The tier A clue that quotes text is located by its OCR line only: the detector is not asked.
  assert.deepEqual(signage.objectTargets, []);
  assert.ok(signage.regions.length > 0 && signage.regions.every(region => region.kind === 'text'));
  assert.deepEqual(landmark.objectTargets, ['domed hall', 'clock tower']);
  assert.ok(landmark.regions.every(region => region.kind === 'object') && landmark.regions.length === 2);
  // Tier B: its quoted text is matched against OCR, nothing goes to the detector.
  assert.deepEqual([caption.objectTargets, caption.textTargets], [[], ['OPENING HOUR']]);
  assert.ok(caption.regions.length > 0 && caption.regions.every(region => region.kind === 'text'));
  // Tier C: not looked for at all, even though OCR read the text it quotes. That is not "not found".
  assert.deepEqual([season.objectTargets, season.textTargets, season.regions, season.localization], [[], [], [], 'not_searched']);
  assert.deepEqual([result.summary.policy.name, result.summary.detection.queryCount], ['tiered', 2]);
  assert.equal('searched' in signage, false);
  // Without a policy every clue is searched, as before.
  asked.length = 0;
  const all = await linkRegions({ bytes: Buffer.from('i'), clues: tiered, model: 'm', llm: async () => ({ text: answer, raw: {} }), ocr: async () => ocrResult, detect });
  assert.deepEqual(asked, ['awning sign', 'glass door', 'menu poster', 'caption text', 'bare tree', 'domed hall', 'clock tower', 'flag pole']);
  assert.equal(all.summary.policy.name, 'all'); assert.equal('risk' in all.clues[0], false);
});
