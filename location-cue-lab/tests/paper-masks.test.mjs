import test from 'node:test';
import assert from 'node:assert/strict';
import { maskRegions,maskRunRegions,maskableRegions,maskArea,validMask,MASK_VERSION } from '../lib/paper-masks.mjs';
import { viewerData } from '../lib/paper-viewer.mjs';

const box=(bbox,query='q')=>({kind:'object',bbox,query,score:0.6});
const run=()=>({id:'run-1',image:{width:800,height:600},errors:[],regions:{version:'x'},predictions:[],clues:[
  {id:'clue-0',category:'c',detail:'A gate',textTargets:[],objectTargets:['gate'],regions:[box([0.1,0.1,0.5,0.5],'gate'),box([0.6,0.6,0.9,0.9],'emblem')]},
  {id:'clue-1',category:'c',detail:'The same gate',textTargets:[],objectTargets:['gate'],regions:[box([0.1,0.1,0.5,0.5],'gate')]},
  // A clue that quotes text: its detector box gets no mask, its text line is not a detector box.
  {id:'clue-2',category:'c',detail:'Sign reads "CAFE"',textTargets:['CAFE'],objectTargets:[],regions:[{kind:'text',bbox:[0,0,0.1,0.1],quoted:'CAFE',match:'exact'},box([0.2,0.2,0.4,0.4],'sign')]},
  {id:'clue-3',category:'c',detail:'Winter'}]});
// A 4x2 mask with the middle two cells of the first row set.
const mask=id=>({id,score:0.9,size:[2,4],counts:[1,2,5]});
const fakeSegment=calls=>async(bytes,boxes,options)=>{calls.push({boxes,options});return {engine:'Segment Anything',model:'fixture',revision:'r',masks:boxes.map(entry=>mask(entry.id)),timing:{encodeMs:1}};};

test('a mask is valid when its runs add up to its grid, and its area is the share that is set',()=>{
  assert.equal(validMask({size:[2,4],counts:[1,2,5]}),true);
  assert.equal(validMask({size:[2,4],counts:[0,8]}),true);
  assert.equal(validMask({size:[2,4],counts:[1,2,4]}),false);
  assert.equal(validMask({size:[2,4],counts:[1,-2,9]}),false);
  assert.equal(validMask({size:[2],counts:[2]}),false);assert.equal(validMask(null),false);
  assert.equal(maskArea({size:[2,4],counts:[1,2,5]}),0.25);assert.equal(maskArea({size:[2,4],counts:[0,8]}),1);assert.equal(maskArea({size:[2,4],counts:[8]}),0);
});

test('each distinct detector box is segmented once and every region that has it gets the mask',async()=>{
  const record=run(),calls=[];
  assert.equal(maskableRegions(record).length,3);
  const {summary}=await maskRegions({bytes:Buffer.from('x'),run:record,segment:fakeSegment(calls),maskSide:128});
  assert.deepEqual(calls[0].boxes.map(entry=>entry.bbox),[[0.1,0.1,0.5,0.5],[0.6,0.6,0.9,0.9]]);assert.deepEqual(calls[0].options,{maskSide:128});
  assert.deepEqual([summary.version,summary.boxes,summary.regions,summary.model,summary.maskSide,summary.verification],[MASK_VERSION,2,3,'fixture',128,'none']);
  assert.deepEqual(record.clues[0].regions.map(region=>region.mask),[{size:[2,4],counts:[1,2,5],score:0.9},{size:[2,4],counts:[1,2,5],score:0.9}]);
  assert.deepEqual(record.clues[1].regions[0].mask.counts,[1,2,5]);
  assert.ok(record.clues[2].regions.every(region=>!('mask' in region)));
  // The box is kept as it was.
  assert.deepEqual(record.clues[0].regions[0].bbox,[0.1,0.1,0.5,0.5]);
  // Nothing to segment: the segmenter is not called.
  const none=await maskRegions({bytes:Buffer.from('x'),run:{clues:[{id:'c',textTargets:[],regions:[]}]},segment:async()=>{throw new Error('called');}});
  assert.equal(none.summary.boxes,0);
});

test('a record is masked once, an unlinked one not at all, and a bad answer is an error on the record',async()=>{
  const saved=[],store={image:()=>Buffer.from('x'),saveRun:record=>{saved.push(record.id);return record;}},calls=[];
  const record=await maskRunRegions({store,run:run(),segment:fakeSegment(calls)});
  assert.equal(record.masks.boxes,2);assert.equal(calls.length,1);
  await maskRunRegions({store,run:record,segment:fakeSegment(calls)});assert.equal(calls.length,1);
  await maskRunRegions({store,run:record,segment:fakeSegment(calls),force:true});assert.equal(calls.length,2);
  const unlinked=await maskRunRegions({store,run:{...run(),regions:null},segment:fakeSegment(calls)});
  assert.equal(unlinked.masks,undefined);assert.equal(calls.length,2);
  const broken=await maskRunRegions({store,run:run(),segment:async(bytes,boxes)=>({masks:boxes.map(entry=>({id:entry.id,score:1,size:[2,4],counts:[3]}))})});
  assert.equal(broken.masks,undefined);assert.deepEqual(broken.errors.map(error=>[error.stage,error.code]),[['masks','MASK_INVALID']]);
});

test('the viewer gets the mask of a detector box as run lengths, without the score',async()=>{
  const record=run();
  await maskRegions({bytes:Buffer.from('x'),run:record,segment:fakeSegment([])});
  const photo=viewerData([{run:record,title:'사진 1'}]).photos[0];
  assert.deepEqual(photo.clues[0].regions[0].mask,{size:[2,4],counts:[1,2,5]});
  assert.ok(photo.clues[2].regions.every(region=>!('mask' in region)));
});
