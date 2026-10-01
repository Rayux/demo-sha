import { promises as fs } from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
if (args.includes('--check')) process.exit(0);
const output=value('--output'), model=value('--model'), source=value('--url') || '';
const emit=value=>console.log(JSON.stringify(value));
const first={start:0.2,end:1.8,text:'はい。'}, second={start:60.2,end:61.8,text:'いいえ。'};
emit({type:'metadata',duration:120,mediaMode:'audio'});
emit({type:'chunk',duration:120,processedThrough:60,cues: source.includes('silent') ? [] : [first],timings:{sourceSetupMs:5,audioWaitMs:10,recognitionMs:20}});
await fs.writeFile(path.join(model,'first-chunk'), 'ready');
if (source.includes('slow')) await new Promise(resolve=>setTimeout(resolve,30000));
// The fixture waits until translation has started, proving stages overlap.
if (source.includes('overlap')) {
 for(let i=0;i<150;i++) {
  try { await fs.stat(path.join(model,'translation-started')); break; }
  catch { await new Promise(resolve=>setTimeout(resolve,10)); }
 }
 await fs.stat(path.join(model,'translation-started'));
}
await new Promise(resolve=>setTimeout(resolve,150));
if(source.includes('fail')) { console.error('Audio download stopped before completion.'); process.exit(1); }
emit({type:'chunk',duration:120,processedThrough:120,cues:[second],timings:{sourceSetupMs:5,audioWaitMs:15,recognitionMs:40}});
emit({type:'timings',timings:{sourceSetupMs:5,audioWaitMs:19,recognitionMs:45}});
await fs.writeFile(output,JSON.stringify({duration:120,cues:source.includes('silent') ? [second] : [first,second]}));
