import sys,json,pathlib,re,hashlib
w=pathlib.Path(__file__).parent;root=w.parents[2];out=w.parent
sys.path.insert(0,str(root/'output/neverland-tsv/work/python'))
from opencc import OpenCC
cc=OpenCC('s2twp')
meta=json.loads((w/'sources.json').read_text());allrows=[];counts={};prepared=root/'import-data/prepared/neverland-05-12';prepared.mkdir(parents=True,exist_ok=True)
for filename,info in meta.items():
 ep=re.search(r'S01E(\d+)',filename)[1];path=w/f'e{ep}.ready.json'
 if not path.exists():continue
 ready=json.loads(path.read_text());segments=json.loads((w/f'e{ep}.segments.json').read_text())
 assert len(ready['clips'])==len(segments),(ep,'missing clips')
 overridepath=w/f'e{ep}.quality-fixes.json';overrides=json.loads(overridepath.read_text()) if overridepath.exists() else {}
 rows=[['SOURCE',filename],['DURATION',f"{info['duration']:.3f}"]];clips=[];prev=0
 for i,c in enumerate(ready['clips']):
  if str(i) in overrides:c.update(overrides[str(i)])
  assert c['id']==i,(ep,'id',i)
  a,b=round(c['start'],3),round(c['end'],3);jp=c['jp'];ruby=c['ruby'];zh=cc.convert(c['zh'])
  assert 0<=a<b<=info['duration']+.0001,(ep,i,a,b)
  assert a>=prev-.02,(ep,i,'overlap',a,prev)
  assert re.sub(r'\[[^\]]*\]','',ruby)==jp,(ep,i,'furigana mismatch')
  assert all(isinstance(t,str) and t.strip() and not re.search('[\t\r\n\ufffd]',t) for t in [jp,ruby,zh]),(ep,i,'invalid field')
  assert all(re.fullmatch('[ぁ-ゖーゝゞ]+',v) for v in re.findall(r'\[([^\]]*)\]',ruby)),(ep,i,'invalid reading')
  if '語音不清' in jp:assert '語音不清' in zh,(ep,i,'uncertainty not preserved')
  clips.append(dict(start=a,end=b,japanese=jp,rubyText=ruby,translation=zh,analyzed=True,scanned=True,prepared=True))
  rows.append(['CLIP',f'{a:.3f}',f'{b:.3f}',jp,ruby,zh]);prev=b
 actual=hashlib.sha256((root/'audio'/filename).read_bytes()).hexdigest();assert actual==info['sha256']
 payload=dict(source=filename,duration=info['duration'],sourceSha256=actual,clipCount=len(clips),clips=clips,provenance=dict(transcription='groq/whisper-large-v3-turbo; full MP3 plus gap rechecks and reviewed text corrections',translation=('groq/openai/gpt-oss-120b with reviewed corrections' if int(ep)<=6 else 'Codex direct Traditional Chinese translation'+('; initial 54 clips retain Groq draft translations' if ep=='07' else '')),furigana='local kuromoji dictionary with reviewed corrections',humanVerified=False))
 (prepared/(filename[:-4]+'.json')).write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
 (out/(filename[:-4]+'.tsv')).write_text('\n'.join('\t'.join(r) for r in rows)+'\n',encoding='utf-8')
 allrows.extend(rows);counts[ep]=len(clips)
 print(ep,len(clips),'clips',sum('語音不清' in c['japanese'] for c in clips),'unclear; max seconds',round(max(c['end']-c['start'] for c in clips),3))
if len(counts)==8:
 (out/'The Promised Neverland - S01E05-S01E12.tsv').write_text('\n'.join('\t'.join(r) for r in allrows)+'\n',encoding='utf-8')
 first=(root/'output/neverland-tsv/The Promised Neverland - S01E01-S01E04.tsv').read_text()
 (out/'The Promised Neverland - Season 1.tsv').write_text(first+'\n'.join('\t'.join(r) for r in allrows)+'\n',encoding='utf-8')
 print('ALL EIGHT READY',sum(counts.values()))
(w/'completed-counts.json').write_text(json.dumps(counts))
