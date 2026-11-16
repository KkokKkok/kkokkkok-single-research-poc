import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { naverGeocode,koreanOrder,withoutRemarks,googleGeocode,scoreAddresses,geodesicDistanceM,isBlocking,DEFAULT_RADIUS_M,GEOCODERS } from '../lib/paper-score.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { scoreRun } from '../lib/paper-runner.mjs';

const env={NAVER_MAPS_CLIENT_ID:'id',NAVER_MAPS_CLIENT_SECRET:'secret'};
const element=(type,longName)=>({types:[type],longName,shortName:longName,code:''});
const naverBody=addresses=>({status:'OK',meta:{totalCount:addresses.length,page:1,count:addresses.length},addresses,errorMessage:''});
const reply=body=>async()=>({ok:true,json:async()=>body});

test('NAVER geocoding sends the address alone and reads the first result',async()=>{
  let seen;
  const fetchImpl=async(url,options)=>{seen={url,options};return {ok:true,json:async()=>naverBody([
    {x:'127.1054328',y:'37.3595963',addressElements:[element('SIDO','경기도'),element('SIGUGUN','성남시 분당구'),element('RI',''),element('ROAD_NAME','불정로'),element('BUILDING_NUMBER','6')]},
    {x:'1',y:'1',addressElements:[]}])};};
  const found=await naverGeocode('분당구 불정로 6',{fetchImpl,env});
  assert.equal(seen.url.origin+seen.url.pathname,'https://maps.apigw.ntruss.com/map-geocode/v2/geocode');
  // Nothing but the query: a coordinate or filter would let the true position steer the result.
  assert.deepEqual([...seen.url.searchParams.keys()],['query']);assert.equal(seen.url.searchParams.get('query'),'분당구 불정로 6');
  assert.deepEqual([seen.options.headers['x-ncp-apigw-api-key-id'],seen.options.headers['x-ncp-apigw-api-key']],['id','secret']);
  assert.deepEqual(found,{status:'resolved',latitude:37.3595963,longitude:127.1054328,resultCount:2,elementTypes:['SIDO','SIGUGUN','ROAD_NAME','BUILDING_NUMBER'],province:'경기도',district:'성남시 분당구',precise:true,queryForm:'as_written'});
});

test('a romanized address NAVER cannot find as written is retried in English and in Korean order',async()=>{
  assert.equal(koreanOrder('84 Heukseok-ro, Dongjak-gu, Seoul 06974, South Korea'),'Seoul Dongjak-gu Heukseok-ro 84');
  assert.equal(koreanOrder('165 Magokjungang-ro, Gangseo-gu, Seoul 07788'),'Seoul Gangseo-gu Magokjungang-ro 165');
  assert.equal(koreanOrder('12-3 Some-gil, Jung-gu, Busan, Republic of Korea'),'Busan Jung-gu Some-gil 12-3');
  assert.equal(koreanOrder('Sejong-daero 110, Jung-gu, Seoul'),'Seoul Jung-gu Sejong-daero 110');
  // Nothing to rearrange without separate parts.
  assert.equal(koreanOrder('서울특별시 중구 세종대로 110'),null);assert.equal(koreanOrder('Seoul City Hall'),null);assert.equal(koreanOrder('South Korea'),null);
  const hit=naverBody([{x:'126.9',y:'37.5',addressElements:[element('ROAD_NAME','Heukseok-ro'),element('BUILDING_NUMBER','84')]}]);
  const seen=[];
  const fetchImpl=async url=>{seen.push([url.searchParams.get('query'),url.searchParams.get('language')]);return {ok:true,json:async()=>seen.length<3?naverBody([]):hit};};
  const found=await naverGeocode('84 Heukseok-ro, Dongjak-gu, Seoul 06974',{fetchImpl,env});
  // As written first (what the repository does), then the two forms NAVER needs. No coordinate or filter, ever.
  assert.deepEqual(seen,[['84 Heukseok-ro, Dongjak-gu, Seoul 06974',null],['84 Heukseok-ro, Dongjak-gu, Seoul 06974','eng'],['Seoul Dongjak-gu Heukseok-ro 84','eng']]);
  assert.deepEqual([found.status,found.queryForm,found.precise],['resolved','reordered_eng',true]);
  // Still nothing: no_result, after every form was tried. A rejected key stops at once.
  const tried=[];
  assert.deepEqual(await naverGeocode('1 A-ro, B-gu, C',{fetchImpl:async url=>{tried.push(url.searchParams.get('query'));return {ok:true,json:async()=>naverBody([])};},env}),{status:'no_result'});
  assert.equal(tried.length,3);
  let calls=0;
  assert.deepEqual(await naverGeocode('1 A-ro, B-gu, C',{fetchImpl:async()=>{calls++;return {ok:false,status:401};},env}),{status:'http_401'});assert.equal(calls,1);
  const score=await scoreAddresses({addresses:['x'],truth:{latitude:37.5,longitude:126.9},geocoder:'naver',geocode:async()=>({...(await naverGeocode('84 Heukseok-ro, Dongjak-gu, Seoul',{fetchImpl:async url=>({ok:true,json:async()=>url.searchParams.get('query').startsWith('Seoul')?hit:naverBody([])}),env}))}),distance:()=>40});
  assert.deepEqual([score.candidates[0].queryForm,score.withinRadius],['reordered_eng',true]);
});

test('an address with a remark in parentheses is retried without it, and a refused long query does not end the attempt',async()=>{
  assert.equal(withoutRemarks('291 Some-daero, A-gu, Seoul 08608, South Korea (Some Mart A Branch, Some Complex)'),'291 Some-daero, A-gu, Seoul 08608, South Korea');
  assert.equal(withoutRemarks('서울 중구 세종대로 110 (시청)'),'서울 중구 세종대로 110');assert.equal(withoutRemarks('84 Heukseok-ro, Dongjak-gu, Seoul'),'84 Heukseok-ro, Dongjak-gu, Seoul');
  const hit=naverBody([{x:'126.9',y:'37.5',addressElements:[element('ROAD_NAME','Some-daero'),element('BUILDING_NUMBER','291')]}]);
  const long='291 Some-daero, A-gu, Seoul 08608, South Korea (Some Mart A Branch, Some Castle Gold Park Third Complex Shopping Arcade Building)';
  assert.ok(long.length>120);
  const seen=[];
  // Like NAVER: a long query is refused with HTTP 400, a remark finds nothing, the bare address in Korean order is found.
  const fetchImpl=async url=>{const query=url.searchParams.get('query');seen.push([query,url.searchParams.get('language')]);
    return query.length>110?{ok:false,status:400}:{ok:true,json:async()=>query==='Seoul A-gu Some-daero 291'?hit:naverBody([])};};
  const found=await naverGeocode(long,{fetchImpl,env});
  assert.deepEqual([found.status,found.queryForm],['resolved','without_remarks_reordered_eng']);
  assert.deepEqual(seen.slice(-3),[['291 Some-daero, A-gu, Seoul 08608, South Korea',null],['291 Some-daero, A-gu, Seoul 08608, South Korea','eng'],['Seoul A-gu Some-daero 291','eng']]);
  assert.ok(seen.slice(0,-3).every(([query])=>query.length>110));
  // Refused in every form: the refusal is reported. Refused as written but searched without the remark: not found.
  assert.deepEqual(await naverGeocode('x'.repeat(130),{fetchImpl:async()=>({ok:false,status:400}),env}),{status:'http_400'});
  assert.deepEqual(await naverGeocode(long,{fetchImpl:async url=>url.searchParams.get('query').length>110?{ok:false,status:400}:{ok:true,json:async()=>naverBody([])},env}),{status:'no_result'});
  // A rejected key still stops at once, whatever the address looks like.
  let calls=0;
  assert.deepEqual(await naverGeocode(long,{fetchImpl:async()=>{calls++;return {ok:false,status:401};},env}),{status:'http_401'});assert.equal(calls,1);
});

test('NAVER geocoding reports every way it can fail without throwing',async()=>{
  assert.deepEqual(await naverGeocode('a',{fetchImpl:()=>{throw new Error('must not be called');},env:{}}),{status:'key_missing'});
  assert.deepEqual(await naverGeocode('a',{fetchImpl:async()=>({ok:false,status:401}),env}),{status:'http_401'});
  assert.deepEqual(await naverGeocode('a',{fetchImpl:reply(naverBody([])),env}),{status:'no_result'});
  assert.deepEqual(await naverGeocode('a',{fetchImpl:reply({status:'INVALID_REQUEST'}),env}),{status:'INVALID_REQUEST'});
  assert.deepEqual(await naverGeocode('a',{fetchImpl:reply(naverBody([{x:'',y:'',addressElements:[]}])),env}),{status:'invalid_location'});
  // A match on a district only (no building or land number) resolves but is not precise.
  const district=await naverGeocode('a',{fetchImpl:reply(naverBody([{x:'127',y:'37',addressElements:[element('SIDO','서울특별시'),element('SIGUGUN','강남구'),element('BUILDING_NUMBER','')]}])),env});
  assert.deepEqual([district.status,district.precise],['resolved',false]);
  assert.deepEqual(['key_missing','http_401','http_429','no_result','INVALID_REQUEST'].map(isBlocking),[true,true,true,false,false]);
});

test('Google geocoding takes the first result, as the repository does',async()=>{
  let url;
  const found=await googleGeocode('1 Main St',{env:{GOOGLE_MAPS_API_KEY:'k'},fetchImpl:async u=>{url=u;return {ok:true,json:async()=>({status:'OK',results:[{geometry:{location:{lat:1,lng:2},location_type:'ROOFTOP'},types:['premise']},{}]})};}});
  assert.deepEqual([...url.searchParams.keys()],['address','key']);
  assert.deepEqual(found,{status:'resolved',latitude:1,longitude:2,resultCount:2,elementTypes:['premise'],precise:true});
  assert.deepEqual(await googleGeocode('x',{env:{GOOGLE_MAPS_API_KEY:'k'},fetchImpl:reply({status:'ZERO_RESULTS',results:[]})}),{status:'no_result'});
  assert.deepEqual([GEOCODERS.naver.matchesPaper,GEOCODERS.google.matchesPaper,DEFAULT_RADIUS_M],[false,true,500]);
});

test('the distance engine is the WGS84 geodesic',()=>{
  // One arc-minute of latitude at 37.5N is about 1,850 m on the WGS84 ellipsoid.
  const metres=geodesicDistanceM({latitude:37.5,longitude:127},{latitude:37.5+1/60,longitude:127});
  assert.ok(Math.abs(metres-1850)<5,String(metres));
  assert.equal(geodesicDistanceM({latitude:37.5,longitude:127},{latitude:37.5,longitude:127}),0);
});

test('the closest geocoded candidate decides the score, against a radius',async()=>{
  const truth={latitude:37,longitude:127,accuracyM:8};
  const places={far:{status:'resolved',latitude:38,longitude:127,resultCount:1,precise:true,elementTypes:[]},near:{status:'resolved',latitude:37.003,longitude:127,resultCount:3,precise:false,elementTypes:[]},none:{status:'no_result'}};
  const distance=(from,to)=>Math.abs(from.latitude-to.latitude)*100000;
  const score=await scoreAddresses({addresses:['far','none','near'],truth,geocoder:'naver',geocode:async address=>places[address],distance});
  assert.deepEqual([score.status,score.bestIndex,Math.round(score.distanceM),score.withinRadius,score.radiusM,score.geocoder,score.truthAccuracyM],['scored',2,300,true,500,'naver',8]);
  assert.deepEqual(score.candidates.map(c=>[c.geocodeStatus,c.distanceM===null,c.resultCount]),[['resolved',false,1],['no_result',true,null],['resolved',false,3]]);
  // Neither the true position nor the geocoder's coordinates are kept.
  assert.ok(!/latitude|longitude/.test(JSON.stringify(score)));
  assert.equal((await scoreAddresses({addresses:['near'],truth,geocoder:'naver',geocode:async a=>places[a],distance,radiusM:100})).withinRadius,false);
  const failed=await scoreAddresses({addresses:['none'],truth,geocoder:'naver',geocode:async a=>places[a],distance});
  assert.deepEqual([failed.status,failed.distanceM,failed.withinRadius],['geocode_failed',null,null]);
  assert.deepEqual(await scoreAddresses({addresses:['a','b'],truth,geocoder:'naver',geocode:async()=>({status:'key_missing'}),distance}),{blocked:true,status:'key_missing'});
});

test('scoreRun fills in unscored predictions, stops on an unusable geocoder, and leaves clues alone',async()=>{
  const directory=mkdtempSync(resolve(tmpdir(),'paper-score-'));
  try{
    const store=new PaperStore(directory);
    const run=store.createRun({width:10,height:10,sha256:'s'},Buffer.from('photo'),{});
    run.status='extracted';run.clues=[{id:'clue-0',category:'Sign',detail:'A',taxonomy:null}];
    run.predictions=[{model:'a',topN:1,status:'answered',addressList:['x'],score:null},{model:'b',topN:1,status:'no_address',addressList:null,score:null}];store.saveRun(run);
    const truth={latitude:37,longitude:127,accuracyM:null},distance=()=>120;let calls=0;
    const geocode=async()=>{calls++;return {status:'resolved',latitude:37,longitude:127,resultCount:1,precise:true,elementTypes:[]};};
    const unavailable=await scoreRun({store,run:store.getRun(run.id),truth,geocoder:'naver',geocode:async()=>({status:'key_missing'}),distance,radiusM:500});
    assert.equal(unavailable.blocked,'key_missing');assert.equal(store.getRun(run.id).predictions[0].score,null);
    const scored=await scoreRun({store,run:store.getRun(run.id),truth,geocoder:'naver',geocode,distance,radiusM:500});
    assert.equal(scored.blocked,null);
    const saved=store.getRun(run.id);
    assert.deepEqual(saved.predictions.map(p=>[p.model,p.score?.status??null,p.score?.withinRadius??null]),[['a','scored',true],['b',null,null]]);
    assert.deepEqual(saved.clues,run.clues);assert.ok(!/"latitude"|"longitude"/.test(JSON.stringify(saved)));
    // Already scored: nothing is geocoded again unless forced.
    await scoreRun({store,run:store.getRun(run.id),truth,geocoder:'naver',geocode,distance,radiusM:500});assert.equal(calls,1);
    await scoreRun({store,run:store.getRun(run.id),truth,geocoder:'naver',geocode,distance,radiusM:50,force:true});
    assert.deepEqual([calls,store.getRun(run.id).predictions[0].score.withinRadius],[2,false]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('pilot ground truth is linked to records by image hash, for the stored copy and its re-encoding',async()=>{
  const { pilotTruths } = await import('../lib/paper-score.mjs');
  const { createHash } = await import('node:crypto');
  const files={
    'pilot/manifest.json':JSON.stringify({cases:[{id:'image-01',sourceAnalysisId:'aaa'},{id:'image-02',sourceAnalysisId:'bbb'},{id:'image-03',sourceAnalysisId:'ccc'},{id:'image-04',sourceAnalysisId:'ddd'}]}),
    'pilot/ground-truth.private.json':JSON.stringify([{id:'image-01',latitude:37.5,longitude:127.0,accuracyM:14.2},{id:'image-02',latitude:null,longitude:null},{id:'image-03',latitude:35.1,longitude:129.0}]),
    'images/aaa.jpg':Buffer.from('stored-a'),'images/bbb.jpg':Buffer.from('stored-b'),'images/ddd.jpg':Buffer.from('stored-d'),
  };
  const key=path=>path.split('\\').join('/');
  const truths=await pilotTruths({pilotDirectory:'pilot',imagesDirectory:'images',read:path=>files[key(path)],exists:path=>key(path) in files,prepare:async bytes=>({image:{sha256:`re-${bytes}`}})});
  // image-02 has no position, image-03 has no stored image, image-04 has no label: only image-01 links.
  assert.equal(truths.size,2);
  const stored=createHash('sha256').update(Buffer.from('stored-a')).digest('hex');
  assert.deepEqual(truths.get(stored),{latitude:37.5,longitude:127.0,accuracyM:14.2,caseId:'image-01'});
  assert.equal(truths.get('re-stored-a'),truths.get(stored));
  // The source is named on the score, and the position still does not reach it.
  const score=await scoreAddresses({addresses:['a'],truth:truths.get(stored),geocoder:'naver',geocode:async()=>({status:'resolved',latitude:37.5,longitude:127.0}),distance:()=>12,truthSource:'location_pilot_exif'});
  assert.equal(score.truthSource,'location_pilot_exif');assert.equal(score.truthAccuracyM,14.2);assert.equal(score.withinRadius,true);
  assert.ok(!JSON.stringify(score).includes('37.5')&&!JSON.stringify(score).includes('image-01'));
});

test('risk evidence is the clue list of predictions within the radius, and the preview shows it',async()=>{
  const { riskEvidence } = await import('../lib/paper-score.mjs');
  const { buildPreviewHtml } = await import('../lib/paper-preview.mjs');
  const prediction=(model,score,clueList=['Sign reads <A>','Statue'])=>({model,transport:'handoff',topN:1,status:'answered',addressList:['1 A-ro, B-gu, Seoul'],clueList,score});
  const scored=(distanceM,withinRadius)=>({status:'scored',distanceM,withinRadius,radiusM:500,geocoder:'naver'});
  const run={id:'run-1',stages:{detector:{model:'m',transport:'handoff'}},clues:[],predictions:[
    prediction('hit',scored(74.4,true)),prediction('miss',scored(13389,false)),prediction('failed',{status:'geocode_failed',distanceM:null,withinRadius:null,radiusM:500}),prediction('unscored',null),prediction('empty',scored(10,true),[])]};
  // Only a scored hit with clues counts; a miss, a failed geocode and an unscored prediction do not.
  assert.deepEqual(riskEvidence(run),[{model:'hit',transport:'handoff',topN:1,distanceM:74.4,radiusM:500,geocoder:'naver',clues:['Sign reads <A>','Statue']}]);
  assert.deepEqual(riskEvidence({}),[]);
  const html=buildPreviewHtml([{run,overlay:Buffer.from('x'),korean:{risk:['간판 글자','조각상']}}],{generatedAt:'now'});
  assert.ok(html.includes('맞힘: 실제 위치에서 74m (기준 500m 이내)'));assert.ok(html.includes('못 맞힘: 실제 위치에서 13.4km (기준 500m 밖)'));
  assert.ok(html.includes('채점 불가: 답을 좌표로 바꾸지 못함'));assert.ok(html.includes('아직 채점하지 않음'));
  // The Korean rendering is used when it lines up with the clue list; the list appears for hits only.
  assert.equal((html.match(/위험 근거\(추정\): 이 추정에서/g)||[]).length,2);assert.ok(html.includes('<li>간판 글자</li><li>조각상</li>'));
  const english=buildPreviewHtml([{run,overlay:Buffer.from('x'),korean:{risk:['개수가-맞지-않는-번역']}}],{generatedAt:'now'});
  assert.ok(english.includes('<li>Sign reads &lt;A&gt;</li>'));assert.ok(!english.includes('개수가-맞지-않는-번역'));
});

test('place search reads NAVER API HUB results and scores each quoted text against the true position',async()=>{
  const { naverPlaceSearch,scorePlaceSearch } = await import('../lib/paper-score.mjs');
  const { placeQueries,searchPlacesRun } = await import('../lib/paper-runner.mjs');
  const hubEnv={NAVER_APIHUB_CLIENT_ID:'hub-id',NAVER_APIHUB_CLIENT_SECRET:'hub-secret'};
  let seen;
  const fetchImpl=async(url,options)=>{seen={url,options};return {ok:true,json:async()=>({total:2,start:1,display:5,items:[
    {title:'<b>루트</b>하우스',category:'카페,디저트>카페',address:'지번',roadAddress:'도로명',mapx:'1268300000',mapy:'375600000'},
    {title:'루트하우스 2호점',category:'카페',mapx:'127.1',mapy:'37.4'},{title:'좌표 없음',mapx:'',mapy:''}]})};};
  const found=await naverPlaceSearch('ROOT HAUS',{fetchImpl,env:hubEnv});
  assert.equal(seen.url.origin+seen.url.pathname,'https://naverapihub.apigw.ntruss.com/search/v1/local');
  // Only the text and the result count go out: nothing that could point the search at the true place.
  assert.deepEqual([...seen.url.searchParams.entries()],[['query','ROOT HAUS'],['display','5']]);
  assert.deepEqual([seen.options.headers['X-NCP-APIGW-API-KEY-ID'],seen.options.headers['X-NCP-APIGW-API-KEY']],['hub-id','hub-secret']);
  // Tags are stripped, degrees x 10^7 are scaled, an item without a position is dropped.
  assert.deepEqual(found,{status:'resolved',total:2,places:[{title:'루트하우스',category:'카페,디저트>카페',latitude:37.56,longitude:126.83},{title:'루트하우스 2호점',category:'카페',latitude:37.4,longitude:127.1}]});
  assert.deepEqual(await naverPlaceSearch('x',{fetchImpl:()=>{throw new Error('no call');},env}),{status:'key_missing'});
  assert.deepEqual(await naverPlaceSearch('x',{fetchImpl:async()=>({ok:false,status:401}),env:hubEnv}),{status:'http_401'});
  assert.deepEqual(await naverPlaceSearch('x',{fetchImpl:async()=>({ok:true,json:async()=>({total:0,items:[]})}),env:hubEnv}),{status:'no_result',total:0,places:[]});

  const truth={latitude:37.56,longitude:126.83,accuracyM:20};
  const distance=(from,to)=>Math.round(Math.hypot(from.latitude-to.latitude,from.longitude-to.longitude)*100000);
  const search=async query=>query==='ROOT HAUS'?found:query==='chain'?{status:'resolved',total:120,places:[{title:'먼 지점',category:'',latitude:37.9,longitude:127.5},{title:'가까운 지점',category:'',latitude:37.561,longitude:126.83}]}:{status:'no_result',total:0,places:[]};
  const unique=await scorePlaceSearch({query:'ROOT HAUS',truth,search,distance});
  assert.deepEqual([unique.status,unique.total,unique.topWithinRadius,unique.anyWithinRadius,unique.topDistanceM,unique.bestRank],['resolved',2,true,true,0,1]);
  assert.deepEqual(unique.results.map(result=>[result.rank,result.title]),[[1,'루트하우스'],[2,'루트하우스 2호점']]);
  // A chain name: the place is among the results but is not the first one.
  const chain=await scorePlaceSearch({query:'chain',truth,search,distance});
  assert.deepEqual([chain.topWithinRadius,chain.anyWithinRadius,chain.bestRank,chain.total],[false,true,2,120]);
  const none=await scorePlaceSearch({query:'nothing',truth,search,distance});
  assert.deepEqual([none.status,none.topWithinRadius,none.anyWithinRadius,none.bestDistanceM],['no_result',null,null,null]);
  // No coordinate or address is kept in what gets stored.
  assert.ok(!/latitude|longitude|도로명|지번/.test(JSON.stringify([unique,chain,none])));
  assert.deepEqual(await scorePlaceSearch({query:'x',truth,search:async()=>({status:'http_401'}),distance}),{blocked:true,status:'http_401'});

  const directory=mkdtempSync(resolve(tmpdir(),'paper-places-'));
  try{
    const store=new PaperStore(directory);
    const run=store.createRun({width:10,height:10,sha256:'s'},Buffer.from('i'),{});
    run.status='extracted';
    run.clues=[{id:'clue-0',category:'Sign',detail:'Reads "ROOT HAUS" and "chain"',textTargets:['ROOT HAUS','chain'],regions:[{kind:'text',quoted:'ROOT HAUS'}]},{id:'clue-1',category:'Poster',detail:'Says "ROOT HAUS" again and "nothing"'}];
    store.saveRun(run);
    // Each text once, with every clue it came from; textTargets when present, else the quotes in the detail.
    assert.deepEqual(placeQueries(run),[{query:'ROOT HAUS',clueIds:['clue-0','clue-1'],seenByOcr:true},{query:'chain',clueIds:['clue-0'],seenByOcr:false},{query:'nothing',clueIds:['clue-1'],seenByOcr:false}]);
    const result=await searchPlacesRun({store,run:store.getRun(run.id),truth,search,distance,truthSource:'location_pilot_exif'});
    assert.equal(result.blocked,null);
    assert.deepEqual(result.run.placeSearches.map(s=>[s.query,s.topWithinRadius,s.anyWithinRadius,s.clueIds.length,s.seenByOcr,s.truthSource]),[['ROOT HAUS',true,true,2,true,'location_pilot_exif'],['chain',false,true,1,false,'location_pilot_exif'],['nothing',null,null,1,false,'location_pilot_exif']]);
    assert.ok(!/latitude|longitude/.test(JSON.stringify(store.getRun(run.id))));
    // Already searched: nothing is sent again unless forced. A rejected key leaves the record alone.
    let calls=0;const counting=async query=>{calls++;return search(query);};
    await searchPlacesRun({store,run:store.getRun(run.id),truth,search:counting,distance});assert.equal(calls,0);
    await searchPlacesRun({store,run:store.getRun(run.id),truth,search:counting,distance,force:true});assert.equal(calls,3);
    const blocked=await searchPlacesRun({store,run:store.getRun(run.id),truth,search:async()=>({status:'http_401'}),distance,force:true});
    assert.equal(blocked.blocked,'http_401');assert.equal(store.getRun(run.id).placeSearches.length,3);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('the preview lists what each quoted text found in place search',async()=>{
  const { buildPreviewHtml } = await import('../lib/paper-preview.mjs');
  const search=(query,fields)=>({query,status:'resolved',total:1,radiusM:500,results:[{rank:1,title:'t',category:'',distanceM:12}],topDistanceM:12,bestDistanceM:12,bestRank:1,topWithinRadius:true,anyWithinRadius:true,seenByOcr:true,...fields});
  const run={id:'run-1',stages:{detector:{model:'m',transport:'handoff'}},clues:[],placeSearches:[
    search('ROOT <HAUS>'),search('chain',{total:120,topDistanceM:41000,bestRank:3,topWithinRadius:false}),search('far',{topDistanceM:9000,bestDistanceM:9000,topWithinRadius:false,anyWithinRadius:false,seenByOcr:false}),
    search('nothing',{status:'no_result',total:0,results:[],topDistanceM:null,bestDistanceM:null,bestRank:null,topWithinRadius:null,anyWithinRadius:null})]};
  const html=buildPreviewHtml([{run,overlay:Buffer.from('x')}],{generatedAt:'now'});
  assert.ok(html.includes('4개 중 1개가 첫 결과로 이 장소를 가리킴 (기준 500m)'));
  assert.ok(html.includes('<code>ROOT &lt;HAUS&gt;</code></td><td>1곳</td><td>12m</td><td><strong>첫 결과가 이 장소</strong>'));
  assert.ok(html.includes('<td>120곳</td><td>41.0km</td><td>3번째 결과가 이 장소</td>'));
  assert.ok(html.includes('(OCR은 못 읽음)</span></td><td>1곳</td><td>9.0km</td><td>다른 곳만 나옴</td>'));
  assert.ok(html.includes('<td>—</td><td>—</td><td><span class="none">검색 결과 없음</span></td>'));
  // No block at all for a record that was never searched.
  assert.ok(!buildPreviewHtml([{run:{...run,placeSearches:undefined},overlay:Buffer.from('x')}],{generatedAt:'now'}).includes('장소 검색에 넣은 결과'));
});

test('place search counts the places it got and decodes entities in names',async()=>{
  const { naverPlaceSearch } = await import('../lib/paper-score.mjs');
  const hubEnv={NAVER_APIHUB_CLIENT_ID:'hub-id',NAVER_APIHUB_CLIENT_SECRET:'hub-secret'};
  // The API reports total 5 whatever it found, so the count is taken from the items.
  const one=await naverPlaceSearch('x',{env:hubEnv,fetchImpl:async()=>({ok:true,json:async()=>({total:5,display:5,items:[{title:'본죽&amp;비빔밥<b>cafe</b> &lt;점&gt;',category:'음식점&gt;죽',mapx:'1269783882',mapy:'375666103'}]})})});
  assert.deepEqual([one.total,one.places[0].title,one.places[0].category],[1,'본죽&비빔밥cafe <점>','음식점>죽']);
  assert.deepEqual([Number(one.places[0].latitude.toFixed(7)),Number(one.places[0].longitude.toFixed(7))],[37.5666103,126.9783882]);
  const none=await naverPlaceSearch('x',{env:hubEnv,fetchImpl:async()=>({ok:true,json:async()=>({total:5,display:5,items:[]})})});
  assert.deepEqual(none,{status:'no_result',total:0,places:[]});
});
