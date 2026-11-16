import test from 'node:test';
import assert from 'node:assert/strict';
import {sharp} from '../lib/config.mjs';
import {modelContent,maskImage,validatePrediction,geocodeAddress,callExperimentModel,predictionSchema} from '../lib/location-experiment.mjs';
test('model payload is restricted to pixels and parsed detector evidence',()=>{
  const b=Buffer.from('image'),extra={categories:[{category:'sign',details:'letters'}],latitude:12};
  assert.throws(()=>modelContent(b,'geominer',extra));
  const payload=JSON.stringify(modelContent(b,'geominer',{categories:extra.categories}));
  assert.ok(!payload.includes('latitude'));assert.equal(modelContent(b,'masked_sign').length,1);
});
test('mask changes only the selected pixel rectangle without metadata',async()=>{
  const original=await sharp({create:{width:10,height:10,channels:3,background:'#ffffff'}}).png().toBuffer();
  const masked=await maskImage(original,[.2,.2,.5,.5]);const raw=await sharp(masked).removeAlpha().raw().toBuffer();
  for(let y=0;y<10;y++)for(let x=0;x<10;x++)assert.equal(raw[(y*10+x)*3],x>=2&&x<5&&y>=2&&y<5?128:255);
  assert.equal((await sharp(masked).metadata()).exif,undefined);
});
test('prediction abstention and address must agree',()=>{
  assert.throws(()=>validatePrediction({address:'a',abstained:true,cluesUsed:[]}));
  assert.throws(()=>validatePrediction({address:null,abstained:false,cluesUsed:[]}));
  assert.equal(validatePrediction({address:null,abstained:true,cluesUsed:[]}).abstained,true);
});
test('geocoder is not biased by ground truth and rejects ambiguous matches',async()=>{
  const old=process.env.GOOGLE_MAPS_API_KEY;process.env.GOOGLE_MAPS_API_KEY='test';
  try{const r=await geocodeAddress('test address',async url=>{assert.equal(url.searchParams.get('bounds'),null);assert.equal(url.searchParams.get('region'),null);return {ok:true,json:async()=>({status:'OK',results:[{},{}]})};});assert.equal(r.status,'ambiguous');}
  finally{if(old===undefined)delete process.env.GOOGLE_MAPS_API_KEY;else process.env.GOOGLE_MAPS_API_KEY=old;}
});
test('Gemini adapter sends only supplied pixels and prompt, validates structured response',async()=>{
  const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='test';let raw;
  try{
    const result=await callExperimentModel({provider:'gemini',model:'test-model',prompt:'test prompt',schema:predictionSchema,content:modelContent(Buffer.from('pixels'),'vanilla'),onRaw:r=>raw=r,fetchImpl:async(url,options)=>{
      assert.ok(url.endsWith('/models/test-model:generateContent'));const body=JSON.parse(options.body);
      assert.deepEqual(body.contents[0].parts,[{inlineData:{mimeType:'image/png',data:Buffer.from('pixels').toString('base64')}}]);
      assert.equal(body.generationConfig.temperature,0);assert.equal(body.generationConfig.responseMimeType,'application/json');
      return {ok:true,json:async()=>({modelVersion:'test-version',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({address:null,abstained:true,cluesUsed:[]})}]}}]})};
    }});
    assert.equal(result.abstained,true);assert.equal(raw.responseModel,'test-version');assert.equal(JSON.stringify(raw).includes('test-key'),false);
  }finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;}
});
