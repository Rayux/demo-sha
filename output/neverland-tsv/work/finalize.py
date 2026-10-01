import sys,json,pathlib,re
sys.path.insert(0,str(pathlib.Path(__file__).parent/'python'))
from opencc import OpenCC
cc=OpenCC('s2twp')
w=pathlib.Path(__file__).parent;out=w.parent
durations=json.loads((w/'durations.json').read_text());allrows=[]
for filename,duration in durations.items():
 ep=re.search(r'S01E(\d+)',filename)[1]
 rawp=w/f'e{ep}.asr.json'
 if not rawp.exists(): continue
 raw=json.loads(rawp.read_text()); segs=[s for s in raw['segments'] if s['text'].strip() and s['end']>s['start']]
 paths=[w/f'e{ep}.batch{i}.json' for i in range(0,len(segs),20)]
 if not all(p.exists() for p in paths):continue
 batches=[c for p in paths for c in json.loads(p.read_text())]
 fixes=json.loads((w/f'fixes{ep}.json').read_text()) if (w/f'fixes{ep}.json').exists() else {}
 splits=json.loads((w/f'splits{ep}.json').read_text()) if (w/f'splits{ep}.json').exists() else {}
 clips=[]
 for i,(s,b) in enumerate(zip(segs,batches)):
  if str(i) in splits:
   clips.extend(splits[str(i)]); continue
  text='（語音不清）' if s['avg_logprob']< -1 or s['no_speech_prob']>.85 else s['text'].strip()
  content=fixes.get(str(i),[text,b['ruby'],b['zh']])
  clips.append([s['start'],min(s['end'],duration),*content])
 if ep=='02':clips.append([742.8025,duration,'お願いします','お願[ねが]いします','請多多指教'])
 if (w/f'extra{ep}.json').exists():
  clips.extend(json.loads((w/f'extra{ep}.json').read_text()));clips.sort(key=lambda c:c[0])
 rows=[['SOURCE',filename],['DURATION',f'{duration:.3f}']]
 prev=-1
 for start,end,jp,ruby,zh in clips:
  assert 0<=start<end<=duration,(ep,start,end)
  assert start>=prev,(ep,start,prev)
  assert re.sub(r'\[[^\]]*\]','',ruby)==jp,(ep,jp,ruby)
  assert all(x and not re.search('[\t\r\n]',x) for x in [jp,ruby,zh])
  zh=cc.convert(zh)
  rows.append(['CLIP',f'{start:.3f}',f'{end:.3f}',jp,ruby,zh]);prev=start
 data='\n'.join('\t'.join(r) for r in rows)+'\n'
 (out/filename.replace('.mp3','.tsv')).write_text(data,encoding='utf-8')
 allrows.extend(rows)
 print(ep,len(clips),'clips',duration,'seconds',sum('語音不清' in c[2] for c in clips),'unclear')
if sum(r[0]=='SOURCE' for r in allrows)==4:
 (out/'The Promised Neverland - S01E01-S01E04.tsv').write_text('\n'.join('\t'.join(r) for r in allrows)+'\n',encoding='utf-8')
 print('Combined TSV saved')
