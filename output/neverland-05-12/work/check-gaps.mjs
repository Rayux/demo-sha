import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const kuromoji=require('/Users/ray/shadowing/import-data/tools/node_modules/kuromoji');
const tokenizer=await new Promise((resolve,reject)=>kuromoji.builder({dicPath:'/Users/ray/shadowing/import-data/tools/node_modules/kuromoji/dict'}).build((e,t)=>e?reject(e):resolve(t)));
function ruby(text){return tokenizer.tokenize(text).map(t=>/[一-龯々]/.test(t.surface_form)&&t.reading?`${t.surface_form}[${t.reading.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96))}]`:t.surface_form).join('');}

import {execFileSync} from 'node:child_process';
const root='/Users/ray/shadowing',work=root+'/output/neverland-05-12/work';
const key=fs.readFileSync(root+'/.env','utf8').match(/^GROQ_API_KEY\s*=\s*(.*)$/m)?.[1].replace(/^['"]|['"]$/g,'');
async function api(route,body){for(let attempt=0;attempt<12;attempt++){let r;try{r=await fetch('https://api.groq.com/openai/v1/'+route,{method:'POST',headers:{Authorization:`Bearer ${key}`,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});}catch(e){console.log('Connection retry');await new Promise(r=>setTimeout(r,5000));continue;}if(r.ok)return r.json();const message=await r.text();if(r.status===429||r.status>=500){const delay=Number(message.match(/try again in ([\d.]+)s/)?.[1])||Number(r.headers.get('retry-after'))||35;if(delay>300)throw Error(message);console.log('Provider retry',Math.ceil(delay+2),'seconds');await new Promise(resolve=>setTimeout(resolve,(delay+2)*1000));continue;}throw Error(r.status+' '+message.slice(0,1000));}throw Error('Provider retry limit');}

for(const ep of ['05','06','07','08','09','10','11','12']){
const raw=JSON.parse(fs.readFileSync(work+'/e'+ep+'.asr.json'));const filename=fs.readdirSync(root+'/audio').find(f=>f.includes('S01E'+ep));
for(let i=1;i<raw.segments.length;i++){
 const a=raw.segments[i-1].end,b=raw.segments[i].start;if(b-a<=2)continue;
 for(let core=a;core<b;core+=7){const until=Math.min(b,core+7),from=Math.max(0,core-.4),end=until+.4,p=work+'/e'+ep+'.gap-'+core.toFixed(3)+'.json';if(fs.existsSync(p))continue;
 const audio=work+'/gap.m4a';execFileSync('/tmp/kage-audio-tools/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1',['-v','error','-y','-ss',String(from),'-i',root+'/audio/'+filename,'-t',String(end-from),'-ac','1','-ar','16000','-b:a','64k',audio]);
 const f=new FormData();f.append('file',new Blob([fs.readFileSync(audio)]),'clip.m4a');for(const [k,v] of [['model','whisper-large-v3-turbo'],['language','ja'],['response_format','verbose_json'],['timestamp_granularities[]','segment'],['timestamp_granularities[]','word'],['temperature','0']])f.append(k,v);
 const result=await api('audio/transcriptions',f);fs.writeFileSync(p,JSON.stringify({core,until,from,result}));console.log(ep,core,until,result.text);
 }
}
}
