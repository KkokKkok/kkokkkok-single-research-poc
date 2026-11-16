import test from 'node:test';
import assert from 'node:assert/strict';
import { combinationSearches,seoulDistrictKo,haversineM,SEOUL_DISTRICTS } from '../lib/paper-combo.mjs';
import { riskLabels } from '../lib/paper-risk.mjs';

// Positions in a made-up grid: about 111 m per 0.001 degree of latitude.
const at=(latitude,longitude,title)=>({latitude,longitude,title,category:'x'});
const truth={latitude:37.5000,longitude:127.0000};
const flat=(from,to)=>haversineM(from,to);

test('district names for the area search come from Seoul only',()=>{
  assert.equal(Object.keys(SEOUL_DISTRICTS).length,25);
  assert.equal(seoulDistrictKo({province:'Seoul',district:'Mapo-gu'}),'마포구');
  assert.equal(seoulDistrictKo({province:'서울특별시',district:'중구'}),'중구');
  assert.equal(seoulDistrictKo({province:'Busan',district:'Jung-gu'}),null);   // same district name, another city
  assert.equal(seoulDistrictKo({province:'Seoul',district:'Nowhere-gu'}),null);
  assert.equal(seoulDistrictKo(null),null);
});

test('two texts that each name many places reveal the place when one of each lie together',async()=>{
  const asked=[];
  const places={
    '스타벅스':[at(37.6000,127.1000,'스타벅스 A점'),at(37.5003,127.0002,'스타벅스 B점')],
    '롯데캐슬':[at(37.4000,126.9000,'롯데캐슬 1차'),at(37.5005,127.0004,'롯데캐슬 3차')],
    '약국':[at(37.7000,127.2000,'먼 약국')],
  };
  const search=async query=>{asked.push(query);return places[query]?{status:'resolved',places:places[query]}:{status:'no_result',places:[]};};
  const texts=[{query:'스타벅스',clueIds:['clue-0'],tier:'A'},{query:'롯데캐슬',clueIds:['clue-1','clue-2'],tier:'A'},{query:'약국',clueIds:['clue-3'],tier:'B'}];
  const {searches}=await combinationSearches({texts,truth,search,distance:flat});
  const together=searches.find(entry=>entry.texts.join('+')==='스타벅스+롯데캐슬');
  assert.deepEqual([together.kind,together.method,together.status,together.withinRadius,together.placeTitles],['pair','co_location','found',true,['스타벅스 B점','롯데캐슬 3차']]);
  assert.deepEqual(together.clueIds,[['clue-0'],['clue-1','clue-2']]);
  assert.ok(together.distanceM<100&&together.gapM<=300);
  // Not together: the two are typed as one query, which finds nothing here.
  const apart=searches.find(entry=>entry.texts.join('+')==='스타벅스+약국');
  assert.deepEqual([apart.method,apart.status,apart.withinRadius,apart.query],['joint_query','no_result',null,'스타벅스 약국']);
  // Each text is looked up once however many pairs it is in.
  assert.equal(asked.filter(query=>query==='스타벅스').length,1);
  // No guess, no area search. No coordinate in what is returned.
  assert.ok(searches.every(entry=>entry.kind==='pair'));
  assert.ok(!/latitude|longitude/.test(JSON.stringify(searches)));
  // Two tier B texts are not paired.
  const none=await combinationSearches({texts:[{query:'약국',clueIds:['a'],tier:'B'},{query:'롯데캐슬',clueIds:['b'],tier:'B'}],truth,search,distance:flat});
  assert.deepEqual(none.searches,[]);
});

test('a text with the guessed district takes the result nearest the guessed point',async()=>{
  const asked=[];
  const search=async query=>{asked.push(query);return query==='마포구 스타벅스'
    ?{status:'resolved',places:[at(37.5400,126.9500,'스타벅스 먼 점'),at(37.5002,127.0001,'스타벅스 가까운 점'),at(37.5600,126.9000,'스타벅스 다른 점')]}
    :{status:'resolved',places:[at(37.9000,127.5000,'엉뚱한 곳')]};};
  const texts=[{query:'스타벅스',clueIds:['clue-0'],tier:'A'},{query:'OPEN',clueIds:['clue-1'],tier:'B'}];
  // The guess is 400 m off, in the right district: the nearest branch to it is the right one.
  const guess={latitude:37.5036,longitude:127.0000,districtKo:'마포구'};
  const {searches}=await combinationSearches({texts,truth,search,guess,distance:flat});
  const area=searches.find(entry=>entry.kind==='area');
  assert.deepEqual([area.method,area.area,area.status,area.pickedRank,area.placeTitles,area.withinRadius,area.resultCount],['district_nearest_to_guess','마포구','found',2,['스타벅스 가까운 점'],true,3]);
  assert.equal(area.guessWithinRadius,true);   // 400 m: the guess was already at the place
  const far=await combinationSearches({texts,truth,search,guess:{latitude:37.5072,longitude:127.0000,districtKo:'마포구'},distance:flat});
  assert.deepEqual([far.searches.find(entry=>entry.kind==='area').guessWithinRadius,far.searches.find(entry=>entry.kind==='area').withinRadius],[false,true]);
  // Only tier A texts are searched with the district, and the guessed point is not in the result.
  assert.deepEqual([...new Set(asked.filter(query=>query.startsWith('마포구')))],['마포구 스타벅스']);
  assert.ok(!/latitude|longitude|37\.50/.test(JSON.stringify(searches)));
  // A service that refuses the key stops everything.
  const refused=await combinationSearches({texts,truth,search:async()=>({status:'http_401'}),guess,distance:flat});
  assert.deepEqual(refused,{blocked:true,status:'place_search_unavailable'});
});

test('a clue is confirmed by a search that led to the place, potential when tier A, low otherwise',()=>{
  const clue=(id,name,regions)=>({id,category:'c',detail:'d',taxonomy:{number:1,name},regions});
  const run={clues:[
    clue('clue-0','Commercial Signage',[{kind:'text'}]),     // tier A, its text alone found the place
    clue('clue-1','Commercial Signage',[{kind:'object'}]),   // tier A, found in the photo, part of a revealing pair
    clue('clue-2','Building Name Lettering',[{kind:'text'}]),// tier A, found, no search led anywhere
    clue('clue-3','Building Name Lettering',[]),             // tier A, not located in the photo: still potential
    clue('clue-4','Media Overlay Content',[{kind:'text'}]),  // tier B
    clue('clue-5','Climate Indicators',[]),                  // tier C
  ],
  placeSearches:[{query:'ROOT HAUS',clueIds:['clue-0'],topWithinRadius:true,topDistanceM:8},{query:'OPEN',clueIds:['clue-2'],topWithinRadius:false,topDistanceM:9000}],
  comboSearches:[{kind:'pair',method:'co_location',texts:['스타벅스','롯데캐슬'],clueIds:[['clue-1'],['clue-4']],withinRadius:true,distanceM:40},
    {kind:'area',method:'district_nearest_to_guess',texts:['스타벅스'],clueIds:[['clue-2']],area:'마포구',withinRadius:false,distanceM:3000},
    // The guess was already at the place: this hit is not evidence against clue-3.
    {kind:'area',method:'district_nearest_to_guess',texts:['캐슬'],clueIds:[['clue-3']],area:'마포구',guessWithinRadius:true,withinRadius:true,distanceM:90}]};
  const labels=riskLabels(run);
  assert.deepEqual(Object.values(labels.clues).map(entry=>entry.label),['confirmed','confirmed','potential','potential','confirmed','low']);
  assert.deepEqual(labels.counts,{confirmed:3,potential:2,low:1});
  assert.deepEqual([labels.clues['clue-2'].located,labels.clues['clue-3'].located],[true,false]);
  assert.equal(labels.searched,true);
  assert.match(labels.clues['clue-0'].evidence[0],/지도 검색 "ROOT HAUS" → 첫 결과가 실제 위치 \(8m\)/);
  // A tier B clue can be confirmed: the tier is a default, the search is the measurement.
  assert.match(labels.clues['clue-4'].evidence[0],/조합 검색 "스타벅스" \+ "롯데캐슬"/);
  assert.equal(labels.clues['clue-3'].reason,'A 등급. 사진에서 위치를 찾지 못해 상자가 없음');
  // A clue that quotes text is located by an OCR line only: an object box for it does not count.
  const quoting=riskLabels({clues:[{...clue('clue-0','Commercial Signage',[{kind:'object'}]),textTargets:['bhc']},{...clue('clue-1','Commercial Signage',[{kind:'object'},{kind:'text'}]),textTargets:['PIZZAWAY']}]});
  assert.deepEqual(Object.values(quoting.clues).map(entry=>[entry.label,entry.located]),[['potential',false],['potential',true]]);
  assert.equal(quoting.clues['clue-0'].reason,'A 등급. 인용한 글자를 사진에서 찾지 못해 상자가 없음');
  // A combination that lands 300 m away is within the search radius but too far to count.
  const loose=riskLabels({clues:[run.clues[2]],placeSearches:[],comboSearches:[{kind:'pair',method:'joint_query',texts:['a','b'],clueIds:[['clue-2'],[]],withinRadius:true,distanceM:300}]});
  assert.equal(loose.clues['clue-2'].label,'potential');
  // Without any search nothing can be confirmed.
  const unsearched=riskLabels({clues:run.clues});
  assert.deepEqual([unsearched.searched,unsearched.counts.confirmed,unsearched.counts.potential],[false,0,4]);
});
