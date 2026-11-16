// Not a paper step. Matches the quoted texts of stored records against their stored OCR lines again,
// after matchText changed, without reading the photos again (OCR takes 14-30 s a photo; its lines
// are kept in the record). Only adds text regions that are missing; nothing is removed.
//   node scripts/rematch-text.mjs            report what would be added
//   node scripts/rematch-text.mjs --write    add them
import { dataDir } from '../lib/config.mjs';
import { PaperStore } from '../lib/paper-store.mjs';
import { matchText,boundsOf } from '../lib/paper-regions.mjs';

const write=process.argv.includes('--write');
const store=new PaperStore(dataDir);
let records=0,added=0,cluesNewlyLocated=0;
for(const run of store.listRuns()){
  const lines=run.regions?.ocr?.lines;
  if(!lines?.length||!lines[0].polygon)continue;
  let changed=false;
  for(const clue of run.clues){
    if(!clue.textTargets?.length)continue;
    const before=(clue.regions||[]).filter(region=>region.kind==='text').length;
    for(const line of lines){
      const id=`${clue.id}-ocr-${line.id}`;
      if((clue.regions||[]).some(region=>region.id===id))continue;
      const hit=clue.textTargets.map(target=>({target,match:matchText(target,line.text)})).find(candidate=>candidate.match);
      if(!hit)continue;
      (clue.regions??=[]).push({id,source:'paddleocr',kind:'text',bbox:boundsOf(line.polygon),polygon:line.polygon,text:line.text,quoted:hit.target,match:hit.match,score:line.score});
      clue.localization='proposed';added++;changed=true;
      console.log(JSON.stringify({run:run.id.slice(0,8),clue:clue.id,quoted:hit.target,line:line.text,match:hit.match}));
    }
    if(!before&&(clue.regions||[]).some(region=>region.kind==='text'))cluesNewlyLocated++;
  }
  if(changed){records++;if(write)store.saveRun(run);}
}
console.log(JSON.stringify({written:write,records,addedTextRegions:added,cluesNewlyLocated}));
