import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHints,cutOut,variantAngles,backToPhoto,textHintPrompt } from '../lib/paper-text-recheck.mjs';

test('hints: boxes and tilts are read, anything invalid becomes null or level',()=>{
  const hints=parseHints('```json\n{"t0":{"box":[0.8,0.16,0.98,0.24],"tilt":15},"t1":null,"t2":{"box":[0.5,0.5,0.4,0.6],"tilt":0},"t3":{"box":[0.1,0.1,0.2,0.2],"tilt":80}}\n```',['t0','t1','t2','t3','t4']);
  assert.deepEqual(hints,{t0:{box:[0.8,0.16,0.98,0.24],tilt:15},t1:null,t2:null,t3:{box:[0.1,0.1,0.2,0.2],tilt:0},t4:null});
  assert.throws(()=>parseHints('no json',['t0']),/TEXT_HINTS_INVALID/);
  assert.match(textHintPrompt([{key:'t0',text:'학교법인 일송학원'}]),/t0: "학교법인 일송학원"/);
});
test('cut-out: wide margin around the hint, kept inside the photo',()=>{
  assert.deepEqual(cutOut([0.4,0.4,0.6,0.5]).map(v=>+v.toFixed(3)),[0.3,0.3,0.7,0.6]);
  assert.deepEqual(cutOut([0.9,0.0,1.0,0.02]).map(v=>+v.toFixed(3)),[0.85,0,1,0.07]);
});
test('angles: model tilt first, then level, then tilt +-10, within 45 degrees',()=>{
  assert.deepEqual(variantAngles(15),[15,0,25,5]);assert.deepEqual(variantAngles(0),[0,10,-10]);assert.deepEqual(variantAngles(40),[40,0,30]);
});
test('a point of the turned cut-out maps back to the photo',()=>{
  // 200x100 cut-out at (100,50) of a 1000x500 photo, enlarged 2x to 400x200, turned 90 degrees clockwise to 200x400.
  const g={angle:90,turnedWidth:200,turnedHeight:400,enlargedWidth:400,enlargedHeight:200,scale:2,left:100,top:50,width:1000,height:500};
  // The enlarged cut-out's top-left corner ends up at the turned image's top-right corner.
  const [x,y]=backToPhoto([1,0],g);assert.ok(Math.abs(x-0.1)<1e-9&&Math.abs(y-0.1)<1e-9);
  const [cx,cy]=backToPhoto([0.5,0.5],{...g,angle:0,turnedWidth:400,turnedHeight:200});assert.ok(Math.abs(cx-0.2)<1e-9&&Math.abs(cy-0.2)<1e-9);
});

test('OCR match gives a verified region; no match falls back to the model box, marked unverified',async()=>{
  const { sharp }=await import('../lib/config.mjs');
  const { readAround,hintRegion }=await import('../lib/paper-text-recheck.mjs');
  const bytes=await sharp({create:{width:400,height:300,channels:3,background:'#335577'}}).jpeg().toBuffer();
  const hint={box:[0.4,0.4,0.6,0.5],tilt:0};
  let calls=0;
  const reads=async()=>{calls++;return {lines:[{id:'ocr-0',text:'화교법인일송회원',score:0.7,polygon:[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}]};};
  const found=await readAround({bytes,hint,targets:['학교법인 일송학원'],ocr:reads});
  assert.equal(found.verified,true);assert.equal(calls,1);
  assert.deepEqual(found.regions.map(r=>[r.source,r.verified,r.text,r.match]),[['paddleocr_recheck',true,'화교법인일송회원','fuzzy_syllables']]);
  // The cut-out is [0.3,0.3,0.7,0.6] of the photo; the line's box maps back inside it.
  const [x0,y0,x1,y1]=found.regions[0].bbox;assert.ok(x0>0.44&&x1<0.56&&y0>0.4&&y1<0.5);
  calls=0;
  const missed=await readAround({bytes,hint,targets:['학교법인 일송학원','둘째'],quoted:'둘째',ocr:async()=>{calls++;return {lines:[{id:'ocr-0',text:'전혀 다른 글자',score:0.9,polygon:[[0,0],[1,0],[1,1],[0,1]]}]};}});
  assert.equal(missed.verified,false);assert.equal(calls,3);
  assert.deepEqual(missed.regions,[hintRegion(hint,'둘째')]);
  assert.deepEqual([missed.regions[0].source,missed.regions[0].verified,missed.regions[0].bbox,missed.regions[0].match],['model_hint',false,[0.4,0.4,0.6,0.5],'unverified']);
});

test('one reading per clue: a clue is read once, at the model tilt, and takes the model box when that fails',async()=>{
  const { sharp }=await import('../lib/config.mjs');
  const { recheckClues }=await import('../lib/paper-text-recheck.mjs');
  const bytes=await sharp({create:{width:400,height:300,channels:3,background:'#335577'}}).jpeg().toBuffer();
  const clues=[{id:'clue-1',textTargets:['첫째 간판','둘째 간판'],regions:[]},{id:'clue-2',textTargets:['셋째 간판'],regions:[]}];
  const llm=async()=>({text:JSON.stringify({t0:{box:[0.1,0.1,0.3,0.2],tilt:15},t1:{box:[0.5,0.5,0.7,0.6],tilt:0},t2:{box:[0.6,0.1,0.8,0.2],tilt:0}}),raw:{}});
  let calls=0;
  // Only the third text is read; the first clue's one reading goes to its first text and fails.
  const ocr=async()=>{calls++;return {lines:calls===2?[{id:'ocr-0',text:'셋째 간판',score:0.9,polygon:[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}]:[]};};
  const summary=await recheckClues({bytes,clues,model:'m',llm,ocr,triesPerClue:1});
  assert.equal(calls,2);
  assert.deepEqual([summary.clues,summary.verified,summary.standIn,summary.ocrCalls],[2,1,1,2]);
  assert.deepEqual(clues[0].regions.map(r=>[r.source,r.verified,r.bbox,r.quoted]),[['model_hint',false,[0.1,0.1,0.3,0.2],'첫째 간판']]);
  assert.deepEqual(clues[1].regions.map(r=>[r.source,r.verified]),[['paddleocr_recheck',true]]);
});

test('runner: the recheck parks on a hand-off, then adds OCR-verified and stand-in regions to the record',async()=>{
  const { mkdtempSync,rmSync,writeFileSync }=await import('node:fs');const { tmpdir }=await import('node:os');const { resolve }=await import('node:path');
  const { sharp }=await import('../lib/config.mjs');const { PaperStore }=await import('../lib/paper-store.mjs');
  const { handoffLlm,pendingHandoffs }=await import('../lib/paper-handoff.mjs');const { regionStage }=await import('../lib/paper-llm.mjs');
  const { recheckRunText }=await import('../lib/paper-runner.mjs');const { riskLabels }=await import('../lib/paper-risk.mjs');
  const directory=mkdtempSync(resolve(tmpdir(),'paper-recheck-'));
  try{
    const store=new PaperStore(directory),stage=regionStage({},{handoffModel:'stand-in'}),llm=handoffLlm(store.handoffDirectory);
    const bytes=await sharp({create:{width:400,height:300,channels:3,background:'#335577'}}).jpeg().toBuffer();
    const run=store.createRun({width:400,height:300,sha256:'s'},bytes,{});
    const clue=(id,textTargets,regions=[])=>({id,category:'Signage',detail:'d',taxonomy:{number:1,name:'Commercial Signage'},textTargets,objectTargets:[],regions,localization:regions.length?'proposed':'unlocalized'});
    run.status='classified';run.regions={version:'paper-regions-v1'};
    run.clues=[clue('clue-0',['응급의료센터']),clue('clue-1',['CAU']),clue('clue-2',['Puang']),clue('clue-3',['이미 찾음'],[{id:'clue-3-ocr-ocr-0',source:'paddleocr',kind:'text',bbox:[0,0,0.1,0.1]}]),clue('clue-4',[])];
    store.saveRun(run);
    // Unlinked records are left alone.
    assert.equal((await recheckRunText({store,run:{...store.getRun(run.id),regions:undefined},stage,llm,ocr:async()=>({lines:[]})})).regions,undefined);
    store.saveRun(run);
    const ocr=async()=>({lines:[{id:'ocr-0',text:'등급의료센터',score:0.8,polygon:[[0.4,0.4],[0.6,0.4],[0.6,0.6],[0.4,0.6]]}]});
    const parked=await recheckRunText({store,run:store.getRun(run.id),stage,llm,ocr});
    assert.equal(parked.pending.stage,'textHints');assert.equal(parked.regions.textRecheck,undefined);assert.deepEqual(parked.errors,[]);
    const request=pendingHandoffs(store.handoffDirectory)[0];
    // Only the three texts without a text region are asked about, with the photo attached.
    const { readFileSync,existsSync }=await import('node:fs');
    const prompt=readFileSync(resolve(request.directory,'prompt.txt'),'utf8');
    assert.match(prompt,/t0: "응급의료센터"\nt1: "CAU"\nt2: "Puang"\n/);assert.doesNotMatch(prompt,/이미 찾음/);assert.ok(existsSync(resolve(request.directory,'image.jpg')));
    writeFileSync(resolve(request.directory,'response.txt'),'```json\n{"t0":{"box":[0.4,0.4,0.6,0.5],"tilt":0},"t1":{"box":[0.1,0.1,0.3,0.2],"tilt":0},"t2":null}\n```');
    const done=await recheckRunText({store,run:store.getRun(run.id),stage,llm,ocr});
    assert.equal(done.pending,undefined);
    const {createdAt,...summary}=done.regions.textRecheck;
    assert.deepEqual(summary,{version:'text-recheck-v2',model:'stand-in',clues:3,verified:1,standIn:1,noHint:1,ocrCalls:4,transport:'handoff'});
    assert.deepEqual(done.clues.map(c=>(c.regions||[]).map(r=>[r.id,r.source,r.verified])),[[['clue-0-recheck-0','paddleocr_recheck',true]],[['clue-1-recheck-0','model_hint',false]],[],[['clue-3-ocr-ocr-0','paddleocr',undefined]],[]]);
    assert.deepEqual(done.clues.map(c=>c.localization),['proposed','proposed','unlocalized','proposed','unlocalized']);
    assert.deepEqual(Object.values(riskLabels(done).clues).map(entry=>entry.locatedBy),['ocr','model',null,'ocr',null]);
    assert.deepEqual(done.modelCalls.map(c=>[c.stage,c.attempt]),[['textHints',1]]);
    // Done once: a second call changes nothing; force replaces the recheck regions instead of stacking them.
    const again=await recheckRunText({store,run:store.getRun(run.id),stage,llm,ocr:async()=>{throw new Error('OCR_FAILED');}});
    assert.deepEqual(again.errors,[]);
    const forced=await recheckRunText({store,run:store.getRun(run.id),stage,llm,ocr,force:true});
    assert.deepEqual(forced.clues.map(c=>(c.regions||[]).length),[1,1,0,1,0]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
