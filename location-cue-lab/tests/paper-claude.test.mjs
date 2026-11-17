import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeLlm,claudeStages,claudeSettings,buildClaudeRequest,readClaudeResponse,CLAUDE_DEFAULT_MODEL,CLAUDE_TRANSPORT,FALLBACK_BETA,CLAUDE_DETECTOR_PROMPT } from '../lib/paper-claude.mjs';
import { DETECTOR_PROMPT } from '../lib/paper-prompts.mjs';
import { parseDetectorAnswer } from '../lib/paper-pipeline.mjs';
import { quotedStrings } from '../lib/paper-regions.mjs';
import { modelProvider } from '../analysis-server.mjs';

const message=(over={})=>({id:'msg_1',model:'claude-opus-5-5',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5},content:[{type:'thinking',thinking:''},{type:'text',text:'Json:\n'},{type:'text',text:'{}'}],...over});

test('settings default to Fable 5.2 at medium effort and are stored on every step',()=>{
  assert.deepEqual(claudeSettings({}),{model:CLAUDE_DEFAULT_MODEL,effort:'medium'});
  assert.equal(CLAUDE_DEFAULT_MODEL,'claude-fable-5-2');
  assert.deepEqual(claudeSettings({ANALYSIS_MODEL:' claude-sonnet-5-5 ',ANALYSIS_EFFORT:'HIGH'}),{model:'claude-sonnet-5-5',effort:'high'});
  assert.throws(()=>claudeSettings({ANALYSIS_EFFORT:'extreme'}),/INVALID_ANALYSIS_EFFORT/);
  // An OpenAI model name in the environment (the research CLI's) does not leak into these.
  const stages=claudeStages({OPENAI_MODEL:'gpt-x',PAPER_DETECTOR_MODEL:'gpt-y'});
  for(const stage of [...Object.values(stages.paper),stages.rules,stages.regions]){
    assert.equal(stage.model,'claude-fable-5-2');
    assert.equal(stage.transport,CLAUDE_TRANSPORT);
    assert.equal(stage.reasoningEffort,'medium');
    assert.notEqual(stage.matchesPaper,true);
  }
  assert.deepEqual(Object.keys(stages.paper),['detector','clueMiner','classifier']);
});

test('a request is one user message, image first, with effort and the default fallback',()=>{
  const withImage=buildClaudeRequest({model:'claude-opus-5-5',text:'prompt',imageBytes:Buffer.from('jpeg'),effort:'medium'});
  assert.deepEqual(withImage.messages,[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:Buffer.from('jpeg').toString('base64')}},{type:'text',text:'prompt'}]}]);
  assert.deepEqual(withImage.output_config,{effort:'medium'});
  assert.deepEqual([withImage.betas,withImage.fallbacks],[[FALLBACK_BETA],'default']);
  // Nothing this model rejects: no thinking setting, no sampling parameter, no forced tool.
  assert.deepEqual(Object.keys(withImage).sort(),['betas','fallbacks','max_tokens','messages','model','output_config']);
  assert.deepEqual(buildClaudeRequest({model:'m',text:'prompt',effort:'low'}).messages[0].content,[{type:'text',text:'prompt'}]);
});

test('the answer is the text blocks; a refusal or a cut-off answer is an error',()=>{
  const context={model:'claude-opus-5-5',effort:'medium',text:'prompt'};
  const read=readClaudeResponse(message(),context);
  assert.equal(read.text,'Json:\n{}');
  assert.deepEqual([read.raw.responseId,read.raw.responseModel,read.raw.status,read.raw.transport,read.raw.requestedReasoningEffort],['msg_1','claude-opus-5-5','end_turn',CLAUDE_TRANSPORT,'medium']);
  assert.equal(read.raw.promptSha256.length,64);
  assert.throws(()=>readClaudeResponse(message({stop_reason:'refusal',stop_details:{type:'refusal',category:'cyber'},content:[]}),context),error=>error.message==='MODEL_REFUSED'&&error.code==='cyber');
  assert.throws(()=>readClaudeResponse(message({stop_reason:'max_tokens'}),context),/MODEL_INCOMPLETE/);
  assert.throws(()=>readClaudeResponse(message({content:[{type:'thinking',thinking:''}]}),context),/MODEL_INCOMPLETE/);
});

test('the pipeline llm calls the beta messages endpoint and keeps no provider error text',async()=>{
  const sent=[];
  const client={beta:{messages:{create:async request=>{sent.push(request);return message();}}}};
  const llm=claudeLlm({env:{ANALYSIS_EFFORT:'high'},client});
  // A step passes its own reasoningEffort (null here): the configured effort is used.
  const answer=await llm({model:'claude-opus-5-5',text:'prompt',imageBytes:Buffer.from('i'),reasoningEffort:null,attempt:1});
  assert.equal(answer.text,'Json:\n{}');
  assert.equal(sent[0].output_config.effort,'high');
  assert.equal(sent[0].model,'claude-opus-5-5');
  await assert.rejects(llm({model:null,text:'prompt'}),/MODEL_NOT_CONFIGURED/);
  const failing=claudeLlm({env:{},client:{beta:{messages:{create:async()=>{throw new Error('secret sk-ant-xxx in message');}}}}});
  await assert.rejects(failing({model:'m',text:'prompt'}),error=>error.message==='MODEL_REQUEST_FAILED'&&!JSON.stringify(error,Object.getOwnPropertyNames(error)).includes('sk-ant'.concat('-xxx')));
});

test('the server asks Claude unless told to use OpenAI',()=>{
  const claude=modelProvider({});
  assert.equal(claude.name,'claude');
  assert.equal(claude.stages().paper.detector.model,'claude-fable-5-2');
  assert.equal(claude.configured(),true);
  const openai=modelProvider({ANALYSIS_LLM:'openai',OPENAI_MODEL:'gpt-x'});
  assert.equal(openai.stages().paper.detector.transport,'openai-responses');
  assert.equal(openai.configured(),false);
  assert.throws(()=>modelProvider({ANALYSIS_LLM:'other'}),/INVALID_ANALYSIS_LLM/);
});

test('the Detector prompt of the server is the one of the paper without the Think line, asking for Korean and for quotes around written text only',()=>{
  const {text,variant}=CLAUDE_DETECTOR_PROMPT;
  assert.equal(variant,'paper-detector-no-think-korean-v1');
  assert.ok(!text.includes('Think:'));
  assert.ok(text.includes('in Korean')&&text.includes('only around text that is actually written in the photo'));
  // Everything of the paper's prompt but that line is kept in order.
  const [before,after]=DETECTOR_PROMPT.split('Think: put your thoughts here.');
  assert.ok(text.startsWith(before)&&text.includes(after.trim()));
  // A Korean answer in the asked form is read by the same parser, and only the written text is a quote.
  const fence='```';
  const answer=`List:\n${fence}python\ncandidate_categories = [\n"간판"\n]\n${fence}\n\nJson:\n${fence}json\n${JSON.stringify({'간판':'초록색 간판에 "달빛고양이 책방"이라고 적혀 있음','마스코트':'하늘색 용 인형. 푸앙으로 보임'})}\n${fence}\n`;
  const parsed=parseDetectorAnswer(answer);
  assert.deepEqual(parsed.clues.map(clue=>[clue.category,quotedStrings(clue.detail)]),[['간판',['달빛고양이 책방']],['마스코트',[]]]);
});
