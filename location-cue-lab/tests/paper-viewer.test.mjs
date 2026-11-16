import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerData,guessVerdict,photoWarning,VIEWER_HTML } from '../lib/paper-viewer.mjs';

const clue=(id,regions)=>({id,category:'Signage',detail:'Sign reads "CAFE"',taxonomy:{number:11,name:'Commercial Signage',group:'Identification'},textTargets:['CAFE'],objectTargets:['shop sign'],regions});
const run=overrides=>({id:'run-1',image:{width:800,height:600},clues:[],regions:null,predictions:[],...overrides});

test('viewer data keeps the text regions of a clue that quotes text and drops its detector boxes',()=>{
  const regions=[
    {kind:'text',bbox:[0.1,0.1,0.3,0.2],quoted:'CAFE',match:'exact'},
    {kind:'object',bbox:[0.4,0.4,0.6,0.6],query:'shop sign',score:0.62},
    {kind:'object',bbox:[0.7,0.1,0.9,0.3],query:'shop sign',score:0.41},   // a detector box of a clue that quotes text: left out
    {kind:'object',bbox:[0.0,0.0,0.2,0.2],query:'awning',score:0.2},        // left out as well
  ];
  const data=viewerData([{run:run({clues:[clue('clue-0',regions),clue('clue-1',undefined)],regions:{version:'x'}}),korean:{'clue-0':'간판에 "CAFE"'},title:'집_합정 3',folder:'집_합정'}],
    {labels:{'Commercial Signage':'상업 간판','Identification':'식별 표지'},generatedAt:'t'});
  const photo=data.photos[0];
  assert.deepEqual([photo.title,photo.folder,photo.image,photo.width,photo.height,photo.linked,photo.boxes],['집_합정 3','집_합정','images/run-1.jpg',800,600,true,1]);
  assert.deepEqual(photo.clues.map(entry=>entry.n),[1,2]);
  assert.deepEqual(photo.clues[0].taxonomy,{number:11,name:'Commercial Signage',ko:'상업 간판',group:'Identification',groupKo:'식별 표지'});
  assert.equal(photo.clues[0].ko,'간판에 "CAFE"');assert.equal(photo.clues[1].ko,null);
  assert.deepEqual(photo.clues[0].regions.map(region=>[region.kind,region.label,region.score,region.shown]),[['t','CAFE',null,true]]);
  assert.deepEqual(photo.clues[1].regions,[]);
  assert.equal(photo.guess,null);
  // An OCR line carries its outline to the page; a region without one, and a detector box, do not.
  assert.equal('polygon' in photo.clues[0].regions[0],false);
  const outlined=viewerData([{run:run({clues:[{...clue('clue-0',[{kind:'text',bbox:[0.1,0.1,0.5,0.4],polygon:[[0.1,0.2],[0.5,0.1],[0.5,0.3],[0.123456,0.4]],quoted:'CAFE',match:'exact'}]),detail:'d'},
    {...clue('clue-1',[{kind:'object',bbox:[0.4,0.4,0.6,0.6],polygon:[[0.4,0.4],[0.6,0.4],[0.6,0.6]],query:'shop sign',score:0.62}]),detail:'d',textTargets:[]}],regions:{version:'x'}}),title:'사진 1'}]).photos[0];
  assert.deepEqual(outlined.clues[0].regions[0].polygon,[[0.1,0.2],[0.5,0.1],[0.5,0.3],[0.1235,0.4]]);
  assert.equal('polygon' in outlined.clues[1].regions[0],false);
  assert.ok(VIEWER_HTML.includes('<polygon points="'));
  // OCR found the text: "찾음". The model's box stands in for it: "대체돼서 찾음", flagged so the page draws it dashed.
  assert.equal(photo.clues[0].locatedBy,'ocr');assert.equal('standIn' in photo.clues[0].regions[0],false);
  const stood=viewerData([{run:run({clues:[clue('clue-0',[{kind:'text',source:'model_hint',verified:false,bbox:[0.1,0.1,0.3,0.2],polygon:[[0.1,0.1],[0.3,0.1],[0.3,0.2],[0.1,0.2]],quoted:'CAFE',match:'unverified',score:null}])],regions:{version:'x'}}),title:'사진 1'}]).photos[0];
  assert.deepEqual([stood.clues[0].located,stood.clues[0].locatedBy,stood.boxes],[true,'model',1]);
  assert.deepEqual(stood.clues[0].regions.map(region=>[region.kind,region.standIn,region.shown]),[['t',true,true]]);
  assert.ok(VIEWER_HTML.includes('대체돼서 찾음')&&VIEWER_HTML.includes('<strong>찾음</strong>'));
  // A photo a person is asked to look at first carries the question.
  assert.equal(photo.pick,null);
  assert.deepEqual(viewerData([{run:run({clues:[clue('clue-0',undefined)]}),title:'사진 1',pick:{order:2,ask:'상자가 맞나요?'}}]).photos[0].pick,{order:2,ask:'상자가 맞나요?'});
  // A record without regions is listed, with no boxes.
  const bare=viewerData([{run:run({clues:[clue('clue-0',undefined)]}),title:'사진 1'}]).photos[0];
  assert.deepEqual([bare.linked,bare.boxes,bare.folder],[false,0,null]);
});

test('an address guess is judged by distance and district, with or without a position of its own',()=>{
  const guess=fields=>guessVerdict(run({predictions:[{status:'answered',addressList:['a'],clueList:['c'],...fields}]}));
  assert.equal(guessVerdict(run()),null);
  // With a position: 500 m, or 1,000 m in the right district.
  assert.equal(guess({score:{status:'scored',distanceM:480}}).hit,true);
  assert.equal(guess({score:{status:'scored',distanceM:700},districtScore:{match:true}}).hit,true);
  assert.equal(guess({score:{status:'scored',distanceM:700},districtScore:{match:false}}).hit,false);
  assert.equal(guess({score:{status:'scored',distanceM:1200},districtScore:{match:true}}).hit,false);
  // The photo's own position decides even when the folder reference is close.
  assert.equal(guess({score:{status:'scored',distanceM:1500},folderScore:{status:'scored',distanceM:300},districtScore:{match:true}}).hit,false);
  assert.equal(guess({score:{status:'geocode_failed',distanceM:null}}).hit,false);
  // Without one: the folder reference, 1,000 m, and the district must match.
  const folder=guess({score:null,folderScore:{status:'scored',distanceM:900},districtScore:{match:true}});
  assert.deepEqual([folder.hit,folder.basis,folder.distanceM],[true,'folder',900]);
  assert.equal(guess({score:null,folderScore:{status:'scored',distanceM:900},districtScore:{match:false}}).hit,false);
  assert.equal(guess({score:null}).basis,'none');
  assert.match(folder.text,/맞힘 · 폴더 기준점에서 900m · 구 일치/);
});

test('a photo whose place the address guess found is flagged as a whole, without an address',()=>{
  const hit={status:'answered',addressList:['1 Secret-ro, Mapo-gu'],clueList:['c'],score:{status:'scored',distanceM:120}};
  const named=overrides=>({id:'clue-0',category:'c',detail:'d',taxonomy:{number:1,name:'Commercial Signage'},regions:[{kind:'text',bbox:[0,0,0.1,0.1],quoted:'x',match:'exact'}],...overrides});
  // Right guess, nothing confirmed by a search: the scene itself gave the place away.
  assert.equal(photoWarning(run({clues:[named()],predictions:[hit]})).kind,'scene');
  // Right guess that says it read text in the photo: the text gave the place away, not the scene.
  assert.equal(photoWarning(run({clues:[named()],predictions:[{...hit,clueList:["Wall text '서서울미술관 미디어 작가전' names the venue"]}]})).kind,'text');
  // An apostrophe is not a quotation.
  assert.equal(photoWarning(run({clues:[named()],predictions:[{...hit,clueList:["Boats at the water's edge near the tower's base"]}]})).kind,'scene');
  // Right guess and a clue a search confirmed.
  const both=run({clues:[named()],predictions:[hit],placeSearches:[{query:'x',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:5}]});
  assert.equal(photoWarning(both).kind,'scene_and_clue');
  // A wrong guess or no guess: no photo warning, whatever the clues say.
  assert.equal(photoWarning(run({clues:[named()],predictions:[{...hit,score:{status:'scored',distanceM:4000}}]})),null);
  assert.equal(photoWarning(run({clues:[named()],placeSearches:both.placeSearches})),null);
  // The warning reaches the product shape, and carries neither the address nor a distance.
  const product=viewerData([{run:both,title:'사진 1'}],{internal:false}).photos[0];
  assert.equal(product.warning.kind,'scene_and_clue');
  assert.ok(!/Secret-ro|120|\dm\b/.test(JSON.stringify(product)));
});

test('the viewer page carries no photo data and loads it from data.js',()=>{
  assert.ok(VIEWER_HTML.includes('<script src="data.js"></script>'));
  assert.ok(!VIEWER_HTML.includes('data:image/'));
  assert.ok(!/https?:\/\//.test(VIEWER_HTML.replace('http://www.w3.org/2000/svg','')));   // nothing is fetched from elsewhere
});
