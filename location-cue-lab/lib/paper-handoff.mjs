// File hand-off: an `llm` adapter that needs no API key. Each model request is written to its own
// folder and the answer is read back from a file that a stand-in (an assistant session, a person,
// another tool) writes there. The pipeline, prompts and parsers are exactly the ones the API path
// uses; only who answers changes.
//   <root>/<id>/prompt.txt     the complete prompt, byte for byte what the API would receive
//   <root>/<id>/image.jpg      the normalized analysis image, when the request has one
//   <root>/<id>/request.json   id, stand-in label, attempt, hashes
//   <root>/<id>/response.txt   written by the stand-in; the request is pending until it exists
import { mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const readResponse=directory=>{const path=resolve(directory,'response.txt');return existsSync(path)?readFileSync(path,'utf8').replace(/^﻿/,''):'';};

export const HANDOFF_PENDING='HANDOFF_PENDING';
// The instruction given to whoever answers. It is not part of the prompt: prompt.txt stays verbatim.
export const handoffBrief=directory=>[
  'You are standing in for a single vision-language model API call. Work only inside this folder:',
  `  ${directory}`,
  '1. Read prompt.txt. It is the complete prompt, exactly as the model would receive it.',
  '2. If image.jpg exists, look at it. It is the image attached to that prompt.',
  '3. Write your answer to response.txt in the same folder. The file must contain only the answer the',
  '   model would return to that prompt, following the output format the prompt asks for.',
  'Use nothing else: no other files, no web, no knowledge of where the image came from. Do not mention',
  'these instructions in the answer. When response.txt is written, reply with the single word: done',
].join('\n');

// Same request (stand-in, prompt, image, attempt) -> same id, so a re-run finds the stored answer.
export function handoffLlm(root){
  mkdirSync(root,{recursive:true});
  return async({model,reasoningEffort=null,text,imageBytes=null,attempt=1})=>{
    const promptSha256=sha(Buffer.from(text)),imageSha256=imageBytes?sha(imageBytes):null;
    const id=sha(JSON.stringify([model,promptSha256,imageSha256,attempt])).slice(0,16);
    const directory=resolve(root,id);
    if(!existsSync(resolve(directory,'request.json'))){
      mkdirSync(directory,{recursive:true});
      writeFileSync(resolve(directory,'prompt.txt'),text);
      if(imageBytes)writeFileSync(resolve(directory,'image.jpg'),imageBytes);
      writeFileSync(resolve(directory,'request.json'),JSON.stringify({id,createdAt:new Date().toISOString(),standIn:model,attempt,promptSha256,imageSha256,hasImage:Boolean(imageBytes)},null,2));
    }
    const answer=readResponse(directory);
    if(!answer.trim())throw Object.assign(new Error(HANDOFF_PENDING),{handoff:{id,directory}});
    return {text:answer,raw:{requestedModel:model,requestedReasoningEffort:reasoningEffort,responseModel:model,responseId:`handoff-${id}`,status:'completed',usage:null,promptSha256,transport:'handoff'}};
  };
}
export function pendingHandoffs(root){
  if(!existsSync(root))return [];
  return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>resolve(root,entry.name))
    .filter(directory=>existsSync(resolve(directory,'request.json'))&&!readResponse(directory).trim())
    .map(directory=>({...JSON.parse(readFileSync(resolve(directory,'request.json'),'utf8')),directory}))
    .sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
}
