// The Claude API as the model behind the pipeline steps: for the analysis server
// (analysis-server.mjs) and, since 2026-11-18, for the research CLI too (researchProvider below).
// The OpenAI path (paper-llm.mjs) stays as it was and is used only when PAPER_LLM=openai: the paper's
// reference settings are OpenAI models, and this file changes none of them.
//   PAPER_LLM           research CLI only: claude (default) | openai
//   ANTHROPIC_API_KEY   read by the SDK itself (or ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile)
//   ANALYSIS_MODEL      default claude-fable-5-2
//   ANALYSIS_EFFORT     low | medium | high | xhigh | max; default medium (the model's own default,
//                       stated so that a change of the default does not change the results unseen)
// Thinking is always on with this model and is not configured here; effort is the only control.
// A request the safety classifiers decline is run again on the fallback model the API picks
// (`fallbacks: "default"`); the record shows which model answered (responseModel).
import { dependency } from './config.mjs';
import { sha } from './adapters.mjs';
import { paperLlm,paperStages,regionStage,ruleStage,evidenceStage,locatorStage } from './paper-llm.mjs';
import { handoffLlm } from './paper-handoff.mjs';
import { DETECTOR_PROMPT } from './paper-prompts.mjs';

export const CLAUDE_DEFAULT_MODEL='claude-fable-5-2';
export const CLAUDE_TRANSPORT='anthropic-messages';
export const CLAUDE_MAX_TOKENS=16000;
export const FALLBACK_BETA='server-side-fallback-2026-07-01';
const EFFORTS=['low','medium','high','xhigh','max'];
// The paper's Detector prompt asks the model to write out its thoughts ("Think: put your thoughts
// here.") between the category list and the JSON. claude-opus-5-5 declines the whole request for
// that line (stop_reason refusal, category reasoning_extraction; seen 2026-11-17). This variant is
// the paper's prompt without that one line: the list and the JSON, which are all that is parsed,
// are asked for in the same words. Two instructions are added at the end (2026-11-17):
//   the answer in Korean, because the app shows the clue text to Korean users as it is;
//   double quotes only around text written in the photo. Quoted strings are what the pipeline looks
//   for with OCR, and a recognised name in quotes ('Puang' for a plush toy) sent a clue about an
//   object down the text path, where it got no region.
// Guessing the place is still allowed, as in the paper's prompt. A record made with this variant
// says so (detector.promptVariant).
const THINK_LINE='Think: put your thoughts here.';
if(!DETECTOR_PROMPT.includes(THINK_LINE))throw new Error('DETECTOR_PROMPT_CHANGED');
const [beforeThink,afterThink]=DETECTOR_PROMPT.split(THINK_LINE);
export const DETECTOR_ADDITION='Write every category name and every detail in Korean. Use double quotes inside a detail only around text that is actually written in the photo, copied exactly as it is written there. Never put in quotes a name you recognise or infer (a character, a brand, a building, a place): write such a name without quotes.';
export const CLAUDE_DETECTOR_PROMPT={variant:'paper-detector-no-think-korean-v1',text:`${beforeThink}${afterThink.trim()}\n\n${DETECTOR_ADDITION}\n`};
// The research CLI's Detector prompt on Claude: only the Think line is left out. The answer stays in the
// paper's language, so records stay comparable with the earlier ones and with the mined taxonomy.
export const CLAUDE_RESEARCH_DETECTOR_PROMPT={variant:'paper-detector-no-think-v1',text:`${beforeThink}${afterThink.trim()}
`};

export function claudeSettings(env=process.env){
  const model=(env.ANALYSIS_MODEL||'').trim()||CLAUDE_DEFAULT_MODEL,effort=(env.ANALYSIS_EFFORT||'').trim().toLowerCase()||'medium';
  if(!EFFORTS.includes(effort))throw new Error('INVALID_ANALYSIS_EFFORT');
  return {model,effort};
}
// The per-step settings stored on a record, in the shape the OpenAI ones have. `reasoningEffort`
// holds the effort level; no step matches the paper's setting (its models are OpenAI's).
export function claudeStages(env=process.env){
  const {model,effort}=claudeSettings(env),base={OPENAI_MODEL:model};
  const mark=stage=>({...stage,reasoningEffort:effort,maxOutputTokens:CLAUDE_MAX_TOKENS,transport:CLAUDE_TRANSPORT,...(stage.paperModel?{matchesPaper:false}:{})});
  return {detectorPrompt:CLAUDE_DETECTOR_PROMPT,paper:Object.fromEntries(Object.entries(paperStages(base)).map(([name,stage])=>[name,mark(stage)])),rules:mark(ruleStage(base)),regions:mark(regionStage(base))};
}

// One user message: the image (when there is one), then the prompt.
export function buildClaudeRequest({model,text,imageBytes=null,effort}){
  const content=[];
  if(imageBytes)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:imageBytes.toString('base64')}});
  content.push({type:'text',text});
  return {model,max_tokens:CLAUDE_MAX_TOKENS,output_config:{effort},betas:[FALLBACK_BETA],fallbacks:'default',messages:[{role:'user',content}]};
}
// The answer of one response: its text blocks joined. A refusal or a cut-off answer is an error.
export function readClaudeResponse(response,{model,effort,text}){
  const raw={requestedModel:model,requestedReasoningEffort:effort,responseModel:response.model,responseId:response.id,status:response.stop_reason,usage:response.usage,promptSha256:sha(Buffer.from(text)),transport:CLAUDE_TRANSPORT};
  if(response.stop_reason==='refusal')throw Object.assign(new Error('MODEL_REFUSED'),{raw,code:response.stop_details?.category??'refusal'});
  const answer=response.content.filter(block=>block.type==='text').map(block=>block.text).join('');
  if(response.stop_reason!=='end_turn'||!answer)throw Object.assign(new Error('MODEL_INCOMPLETE'),{raw});
  return {text:answer,raw};
}

// llm for the pipeline steps: async ({model,text,imageBytes}) => {text,raw}. The steps pass the
// stage's model; the effort comes from the settings, whatever `reasoningEffort` a step passes.
// client: injected by tests; otherwise the SDK's, which finds the credentials itself.
export function claudeLlm({env=process.env,client=null}={}){
  const {effort}=claudeSettings(env);
  let Anthropic=null;
  return async({model,text,imageBytes=null})=>{
    if(!model)throw new Error('MODEL_NOT_CONFIGURED');
    if(!client){
      const loaded=dependency('@anthropic-ai/sdk');Anthropic=loaded.default??loaded;
      // The SDK refuses to start without a credential it can find.
      try{client=new Anthropic({timeout:300000});}catch{throw new Error('ANTHROPIC_NOT_CONFIGURED');}
    }
    let response;
    try{response=await client.beta.messages.create(buildClaudeRequest({model,text,imageBytes,effort}));}
    catch(error){
      // Only the status and the API's short error type are kept; its message never reaches a record.
      if(Anthropic&&error instanceof Anthropic.APIError)throw Object.assign(new Error('MODEL_REQUEST_FAILED'),{status:error.status??null,code:error.error?.error?.type??null});
      // Not an answer from the API: with no credential in the environment, that is the likely reason.
      throw new Error(Anthropic&&!env.ANTHROPIC_API_KEY&&!env.ANTHROPIC_AUTH_TOKEN?'ANTHROPIC_NOT_CONFIGURED':'MODEL_REQUEST_FAILED');
    }
    return readClaudeResponse(response,{model,effort,text});
  };
}

// Who answers the model steps of the research CLI (scripts/paper.mjs and the experiment scripts):
//   handoff   --handoff <label>: requests go through files and a stand-in answers (paper-handoff.mjs)
//   claude    the default: the Claude API, with the same model and effort as the analysis server
//   openai    PAPER_LLM=openai: the earlier path (OPENAI_API_KEY, OPENAI_MODEL, PAPER_*_MODEL)
// Returns {name, llm, stages, stage(name), detectorPrompt, configured(stage), hint}. stages is the
// paperStages() shape; stage('regions'|'rules'|'evidence'|'locator') the others.
const OTHER_STAGES={regions:regionStage,rules:ruleStage,evidence:evidenceStage,locator:locatorStage};
export function researchProvider(env=process.env,{handoff=null,handoffDirectory=null}={}){
  const pick=(env.PAPER_LLM||'claude').trim().toLowerCase();
  if(handoff)return {name:'handoff',llm:handoffLlm(handoffDirectory),stages:paperStages(env,{handoffModel:handoff}),stage:name=>OTHER_STAGES[name](env,{handoffModel:handoff}),detectorPrompt:null,configured:()=>true,hint:''};
  if(pick==='openai')return {name:'openai',llm:paperLlm,stages:paperStages(env),stage:name=>OTHER_STAGES[name](env),detectorPrompt:null,configured:stage=>Boolean(env.OPENAI_API_KEY&&stage.model),
    hint:'Configure OPENAI_API_KEY and OPENAI_MODEL (or a PAPER_*_MODEL override), or use --handoff <stand-in-label>.'};
  if(pick!=='claude')throw new Error('INVALID_PAPER_LLM');
  const {model,effort}=claudeSettings(env),base={OPENAI_MODEL:model};
  const mark=stage=>({...stage,reasoningEffort:effort,maxOutputTokens:CLAUDE_MAX_TOKENS,transport:CLAUDE_TRANSPORT,...(stage.paperModel?{matchesPaper:false}:{})});
  return {name:'claude',llm:claudeLlm({env}),stages:Object.fromEntries(Object.entries(paperStages(base)).map(([name,stage])=>[name,mark(stage)])),stage:name=>mark(OTHER_STAGES[name](base)),
    detectorPrompt:CLAUDE_RESEARCH_DETECTOR_PROMPT,configured:()=>Boolean(env.ANTHROPIC_API_KEY||env.ANTHROPIC_AUTH_TOKEN),
    hint:'Set ANTHROPIC_API_KEY (in .env), or PAPER_LLM=openai for the OpenAI path, or use --handoff <stand-in-label>.'};
}
