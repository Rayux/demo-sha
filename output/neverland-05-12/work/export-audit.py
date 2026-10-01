from pathlib import Path
import json,re
paths=sorted([p for folder in Path('import-data/prepared').glob('neverland*') for p in folder.glob('*.json')]);allrows=[];changed=[];counts={}
for p in paths:
 d=json.loads(p.read_text());ep=re.search('S01E(\d+)',p.name)[1];old=json.loads((Path('transcripts/overrides')/p.name).read_text());assert len(d['clips'])==len(old['clips']);count=0;prev=0
 for a,b in zip(old['clips'],d['clips']):
  for k in ['japanese','translation','start','end']:assert a[k]==b[k],(ep,k)
  assert re.sub(r'\[[^\]]*\]','',b['rubyText'])==b['japanese']
  assert all(re.fullmatch('[ぁ-ゖーゝゞ]+',r) for r in re.findall(r'\[([^\]]+)\]',b['rubyText'])),(ep,b['rubyText'])
  assert 0<=b['start']<b['end']<=d['duration']+.001 and b['start']>=prev-.02
  prev=b['end'];count+=a['rubyText']!=b['rubyText']
 if count:
  counts[ep]=count;changed.append(str(p));d['provenance']['furigana']='All-season local kuromoji coverage audit and Codex contextual corrections; no new Groq calls'
  p.write_text(json.dumps(d,ensure_ascii=False,indent=2))
 rows=[['SOURCE',d['source']],['DURATION',f"{d['duration']:.3f}"]]+[['CLIP',f"{c['start']:.3f}",f"{c['end']:.3f}",c['japanese'],c['rubyText'],c['translation']] for c in d['clips']]
 out=Path('output')/('neverland-tsv' if int(ep)<=4 else 'neverland-05-12');(out/(d['source'][:-4]+'.tsv')).write_text('\n'.join('\t'.join(r) for r in rows)+'\n',encoding='utf-8')
 allrows.append((ep,rows))
 if int(ep)>=5:
  ready=Path(f'output/neverland-05-12/work/e{ep}.ready.json');rd=json.loads(ready.read_text())
  for c,b in zip(rd['clips'],d['clips']):assert c['jp']==b['japanese'];c['ruby']=b['rubyText']
  ready.write_text(json.dumps(rd,ensure_ascii=False))
allrows.sort()
for name,selected in [('output/neverland-tsv/The Promised Neverland - S01E01-S01E04.tsv',[r for ep,r in allrows if int(ep)<=4]),('output/neverland-05-12/The Promised Neverland - S01E05-S01E12.tsv',[r for ep,r in allrows if int(ep)>=5]),('output/neverland-05-12/The Promised Neverland - Season 1.tsv',[r for ep,r in allrows])]:Path(name).write_text('\n'.join('\t'.join(r) for rows in selected for r in rows)+'\n',encoding='utf-8')
Path('output/neverland-05-12/work/audit-changed.json').write_text(json.dumps(changed));print('CHANGED CLIPS',counts,'TOTAL',sum(counts.values()))
