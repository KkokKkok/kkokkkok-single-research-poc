// Plain-text model call for the paper-method pipeline. The repository's calls set only the
// model, max_completion_tokens=16384 and one user message (text, then the image), with no
// temperature and no response schema; this keeps the same shape on the Responses API.
import { dependency } from './config.mjs';
import { sha } from './adapters.mjs';
export const PAPER_MAX_OUTPUT_TOKENS=16384;

// What each stage used in the paper and its repository. These are reference values only: the
// stages run on the project's current model, and every record says whether that matches.
export const PAPER_STAGE_REFERENCE={
  // experiment.py: --geominer_detector_model defaults to "gpt4o" (MODEL_CONFIGS.gpt4o), whose
  // api_params carry no reasoning_effort. Section 5 of the paper names GPT-4o as a Detector.
  detector:{model:'gpt-4o-2024-11-20',reasoningEffort:null,basis:'experiment.py --geominer_detector_model default (gpt4o)'},
  // clueminer.py: LLMConfig.model. Its call sends no reasoning_effort, so the API default applies.
  clueMiner:{model:'o4-mini-2025-04-16',reasoningEffort:null,basis:'clueminer.py LLMConfig.model'},
  // No code is published for the classifier. Section 4.2 says o4-mini; the snapshot and the
  // request shape are assumed to be the analyzer's.
  classifier:{model:'o4-mini-2025-04-16',reasoningEffort:null,basis:'paper Section 4.2 (o4-mini); snapshot assumed from clueminer.py'},
};
const ENV_NAME={detector:'DETECTOR',clueMiner:'CLUEMINER',classifier:'CLASSIFIER'};
// Model per stage: PAPER_<STAGE>_MODEL, else OPENAI_MODEL (the project's current model), else
// null. No model name is hard-coded as a default, so an outdated snapshot is never used unasked.
// reasoningEffort null means "do not send the parameter", as the repository does for these stages.
// handoffModel: label of whoever answers when requests go through files instead of the API.
export function paperStages(env=process.env,{handoffModel=null}={}){
  return Object.fromEntries(Object.entries(PAPER_STAGE_REFERENCE).map(([stage,paper])=>{
    const model=handoffModel||(env[`PAPER_${ENV_NAME[stage]}_MODEL`]||'').trim()||(env.OPENAI_MODEL||'').trim()||null;
    const reasoningEffort=handoffModel?null:(env[`PAPER_${ENV_NAME[stage]}_REASONING_EFFORT`]||'').trim().toLowerCase()||null;
    if(reasoningEffort&&!/^[a-z]+$/.test(reasoningEffort))throw new Error('INVALID_REASONING_EFFORT');
    return [stage,{model,reasoningEffort,maxOutputTokens:handoffModel?null:PAPER_MAX_OUTPUT_TOKENS,transport:handoffModel?'handoff':'openai-responses',
      paperModel:paper.model,paperReasoningEffort:paper.reasoningEffort,paperBasis:paper.basis,
      matchesPaper:!handoffModel&&model===paper.model&&reasoningEffort===paper.reasoningEffort}];
  }));
}
// The region-target step (paper-regions.mjs) is not from the paper, so it has no reference model.
export function regionStage(env=process.env,{handoffModel=null}={}){
  const model=handoffModel||(env.PAPER_REGION_MODEL||'').trim()||(env.OPENAI_MODEL||'').trim()||null;
  return {model,reasoningEffort:null,maxOutputTokens:handoffModel?null:PAPER_MAX_OUTPUT_TOKENS,transport:handoffModel?'handoff':'openai-responses',paperModel:null,matchesPaper:null};
}
// The rule-sheet judgement (paper-rules.mjs) is not from the paper either: PAPER_RULE_MODEL, else OPENAI_MODEL.
export function ruleStage(env=process.env,{handoffModel=null}={}){
  const model=handoffModel||(env.PAPER_RULE_MODEL||'').trim()||(env.OPENAI_MODEL||'').trim()||null;
  return {model,reasoningEffort:null,maxOutputTokens:handoffModel?null:PAPER_MAX_OUTPUT_TOKENS,transport:handoffModel?'handoff':'openai-responses',paperModel:null,matchesPaper:null};
}
// Evidence normalization (paper-evidence.mjs), not from the paper: PAPER_EVIDENCE_MODEL, else OPENAI_MODEL.
export function evidenceStage(env=process.env,{handoffModel=null}={}){
  const model=handoffModel||(env.PAPER_EVIDENCE_MODEL||'').trim()||(env.OPENAI_MODEL||'').trim()||null;
  return {model,reasoningEffort:null,maxOutputTokens:handoffModel?null:PAPER_MAX_OUTPUT_TOKENS,transport:handoffModel?'handoff':'openai-responses',paperModel:null,matchesPaper:null};
}
// Evaluation only: the model asked where a photo was taken (the paper's CoT experiment). The paper
// mined the clue lists of these three; experiment.py gives o3 reasoning_effort "medium".
export const LOCATOR_REFERENCE=[
  {model:'o3-2025-04-16',reasoningEffort:'medium'},
  {model:'gpt-4.1-2025-04-14',reasoningEffort:null},
  {model:'google/gemini-2.5-pro-preview',reasoningEffort:null},
];
export function locatorStage(env=process.env,{handoffModel=null}={}){
  const model=handoffModel||(env.PAPER_LOCATOR_MODEL||'').trim()||(env.OPENAI_MODEL||'').trim()||null;
  const reasoningEffort=handoffModel?null:(env.PAPER_LOCATOR_REASONING_EFFORT||'').trim().toLowerCase()||null;
  if(reasoningEffort&&!/^[a-z]+$/.test(reasoningEffort))throw new Error('INVALID_REASONING_EFFORT');
  return {model,reasoningEffort,maxOutputTokens:handoffModel?null:PAPER_MAX_OUTPUT_TOKENS,transport:handoffModel?'handoff':'openai-responses',
    paperModel:LOCATOR_REFERENCE.map(reference=>reference.model).join(' / '),paperBasis:'paper Section 4.2: CoT outputs of o3, GPT-4.1 and Gemini 2.5 Pro; experiment.py MODEL_CONFIGS',
    matchesPaper:!handoffModel&&LOCATOR_REFERENCE.some(reference=>reference.model===model&&reference.reasoningEffort===reasoningEffort)};
}
// One user message: the prompt, then the image. `reasoning` is added only when an effort is set,
// because models without reasoning reject the parameter.
export function buildRequest({model,text,imageBytes=null,reasoningEffort=null}){
  const content=[{type:'input_text',text}];
  // detail:'auto' is the API default the repository relies on by not setting it.
  if(imageBytes)content.push({type:'input_image',image_url:`data:image/jpeg;base64,${imageBytes.toString('base64')}`,detail:'auto'});
  return {model,store:false,max_output_tokens:PAPER_MAX_OUTPUT_TOKENS,input:[{role:'user',content}],...(reasoningEffort?{reasoning:{effort:reasoningEffort}}:{})};
}
export async function paperLlm({model,text,imageBytes=null,reasoningEffort=null}){
  if(!process.env.OPENAI_API_KEY||!model)throw new Error('OPENAI_NOT_CONFIGURED');
  const OpenAI=dependency('openai').default;
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:300000,maxRetries:0});
  const r=await client.responses.create(buildRequest({model,text,imageBytes,reasoningEffort}));
  const raw={requestedModel:model,requestedReasoningEffort:reasoningEffort,responseModel:r.model,responseId:r.id,status:r.status,usage:r.usage,promptSha256:sha(Buffer.from(text)),transport:'openai-responses'};
  if(r.status!=='completed'||!r.output_text)throw Object.assign(new Error('MODEL_INCOMPLETE'),{raw});
  return {text:r.output_text,raw};
}
