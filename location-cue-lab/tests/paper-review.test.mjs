import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { applyReview,readReviews,REVIEW_FIELDS } from '../scripts/viewer-server.mjs';
import { reviewSummary } from '../lib/paper-risk.mjs';
import { reviewSample,viewerData } from '../lib/paper-viewer.mjs';

const key='0123abcd-0000-4000-8000-000000000001/clue-3';

test('the viewer server stores only answers the page can give',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-review-'));
  try{
    const path=resolve(directory,'reviews.json');
    assert.deepEqual(await readReviews(path),{version:1,reviews:{}});
    const first=await applyReview({key,field:'box',value:'wrong'},path);
    assert.equal(first.box,'wrong');
    await applyReview({key,field:'risk',value:'yes'},path);
    const stored=JSON.parse(readFileSync(path,'utf8'));
    assert.deepEqual([stored.reviews[key].box,stored.reviews[key].risk],['wrong','yes']);
    // null takes one answer back and leaves the other.
    await applyReview({key,field:'box',value:null},path);
    const after=(await readReviews(path)).reviews[key];
    assert.deepEqual(['box' in after,after.risk],[false,'yes']);
    // Refused: unknown question, unknown answer, a key that is not a record and a clue, a path.
    for(const bad of [{key,field:'note',value:'x'},{key,field:'box',value:'maybe'},{key:'../x/clue-1',field:'box',value:'right'},{key:'__proto__',field:'box',value:'right'},{key,field:'box'}])
      assert.equal(await applyReview(bad,path),null);
    assert.deepEqual(Object.keys((await readReviews(path)).reviews),[key]);
    assert.deepEqual(Object.keys(REVIEW_FIELDS),['box','category','risk']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

const clue=(id,name,regions)=>({id,category:'c',detail:'d',taxonomy:{number:1,name},regions});
const run=(id,clues,extra={})=>({id,image:{width:10,height:10},clues,predictions:[],...extra});

test('answers are counted by the label the clue has now',()=>{
  const runs=[run('0123abcd-0000-4000-8000-000000000001',[clue('clue-0','Commercial Signage',[{kind:'text'}]),clue('clue-1','Commercial Signage',[{kind:'text'}]),clue('clue-2','Climate Indicators',[])],
    {placeSearches:[{query:'q',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:9}]})];
  const id=runs[0].id;
  const summary=reviewSummary(runs,{[`${id}/clue-0`]:{box:'right',category:'right',risk:'yes'},[`${id}/clue-1`]:{box:'wrong',risk:'no'},[`${id}/clue-2`]:{at:'t'},'gone/clue-9':{box:'right'}});
  assert.deepEqual([summary.reviewed,summary.unknown],[2,1]);
  assert.deepEqual(summary.byLabel.confirmed,{clues:1,box:{right:1,partial:0,wrong:0},category:{right:1,wrong:0},risk:{yes:1,no:0,unsure:0}});
  assert.deepEqual([summary.byLabel.potential.box.wrong,summary.byLabel.potential.risk.no,summary.byLabel.low.clues],[1,1,0]);
});

test('the clues to review are every confirmed one and a fixed sample of the potential ones',()=>{
  const entries=Array.from({length:6},(_,index)=>({run:run(`0123abcd-0000-4000-8000-00000000000${index}`,[clue('clue-0','Commercial Signage',[{kind:'text',bbox:[0.1,0.1,0.2,0.2],quoted:'q',match:'exact'}]),clue('clue-1','Climate Indicators',[])],
    index===0?{placeSearches:[{query:'q',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:9}]}:{}),title:`사진 ${index}`}));
  const sample=reviewSample(entries,2);
  assert.equal(sample.size,3);assert.ok(sample.has(`${entries[0].run.id}/clue-0`));
  assert.ok([...sample].every(item=>item.endsWith('/clue-0')));   // low clues are never asked about
  // The same clues whatever the order of the photos.
  assert.deepEqual([...reviewSample([...entries].reverse(),2)].sort(),[...sample].sort());
  const data=viewerData(entries,{reviewSize:2});
  assert.equal(data.photos.flatMap(photo=>photo.clues).filter(item=>item.review).length,3);
});
