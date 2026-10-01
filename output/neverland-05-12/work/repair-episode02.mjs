import fs from 'node:fs';import{createRequire}from'node:module';const require=createRequire(import.meta.url);const k=require('/Users/ray/shadowing/import-data/tools/node_modules/kuromoji');const t=await new Promise((res,rej)=>k.builder({dicPath:'/Users/ray/shadowing/import-data/tools/node_modules/kuromoji/dict'}).build((e,x)=>e?rej(e):res(x)));

const path=process.argv[2];const data=JSON.parse(fs.readFileSync(path));let count=0;const ep='02';for(const c of data.clips){c.jp=c.japanese;c.ruby=c.rubyText;
const text=c.jp;const model=c.ruby;const covered=[];let plain='',last=0;const annotations=[];
for(const m of model.matchAll(/\[([^\]]*)\]/g)){
 plain+=model.slice(last,m.index);const tail=plain.match(/[\p{Script=Han}々][\p{Script=Han}\p{Script=Hiragana}ー々]*$/u)?.[0]||'';covered.push([plain.length-tail.length,plain.length]);annotations.push({at:plain.length,value:m[0]});last=m.index+m[0].length;
}
plain+=model.slice(last);if(plain!==text)throw Error('Invalid model ruby '+ep+' '+c.id);
for(const m of text.matchAll(/（語音不清）/g))covered.push([m.index,m.index+m[0].length]);
let cursor=0;
for(const token of t.tokenize(text)){
 const start=text.indexOf(token.surface_form,cursor);if(start<0)throw Error('Tokenizer offset');const end=start+token.surface_form.length;cursor=end;
 if(!/[\p{Script=Han}々]/u.test(token.surface_form)||!token.reading||covered.some(([a,b])=>start<b&&end>a))continue;
 const reading=token.reading.replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));if(!/^[ぁ-ゖーゝゞ]+$/.test(reading))continue;
 annotations.push({at:end,value:'['+reading+']'});count++;
}
annotations.sort((a,b)=>a.at-b.at);let ruby='',i=0;for(const a of annotations){ruby+=text.slice(i,a.at)+a.value;i=a.at;}ruby+=text.slice(i);if(ruby.replace(/\[[^\]]*\]/g,'')!==text)throw Error('Reading invariant');c.ruby=ruby;

c.rubyText=c.ruby;delete c.jp;delete c.ruby;}
fs.writeFileSync(path,JSON.stringify(data,null,2));console.log('Added readings',count);
