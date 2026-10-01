import json,pathlib,re,difflib
w=pathlib.Path(__file__).parent
import sys
meta=json.loads((w/'sources.json').read_text())
fixes=json.loads((w/'raw-fixes.json').read_text()) if (w/'raw-fixes.json').exists() else {}
def normal(s):return ''.join(c for c in s if c.isalnum() or '\u3040'<=c<='\u30ff' or c=='々')
for filename,m in meta.items():
 ep=re.search(r'S01E(\d+)',filename)[1]
 if len(sys.argv)>1 and ep!=sys.argv[1]:continue
 planpath=w/f'e{ep}.split-plan.json'
 if not planpath.exists():continue
 plan={r['id']:r['parts'] for r in json.loads(planpath.read_text())}
 raw=json.loads((w/f'e{ep}.asr.json').read_text());result=[]
 for i,s in enumerate(raw['segments']):
  start=max(0,s['start']);end=min(m['duration'],s['end']);text=s['text'].strip()
  if end<=start or not text:continue
  cuts=[]
  if end-start>7:
   words=[x for x in raw.get('words',[]) if x['end']>=start-.3 and x['start']<end+.3]
   timeline=[];seq=''
   for word in words:
    n=normal(word['word']);seq+=n;timeline.extend([word]*len(n))
   chars=[(j,c) for j,c in enumerate(text) if normal(c)];target=''.join(c for j,c in chars)
   mapping={}
   for a,b,n in difflib.SequenceMatcher(None,seq,target,autojunk=False).get_matching_blocks():
    for k in range(n):mapping[b+k]=a+k
   if i in plan:
    cuts=[];offset=0;lasttime=start
    for piece in plan[i][:-1]:
     offset+=len(normal(piece))
     if offset>=len(chars):continue
     k=offset
     if k not in mapping:
      nearest=min(mapping,key=lambda n:abs(n-k)) if mapping else None
      if nearest is None:raise ValueError(f'Cannot align episode {ep} segment {i}')
      k=nearest
     tm=timeline[mapping[k]]['start']
     tm=max(lasttime+.05,min(end-.05,tm))
     cuts.append((chars[offset][0],tm));lasttime=tm
   lastcut=start;lastchar=0
   for k in ([] if i in plan else range(1,len(chars))):
    if k not in mapping or k-1 not in mapping:continue
    left=timeline[mapping[k-1]];right=timeline[mapping[k]]
    if left is right:continue
    t=max(left['end'],right['start']);gap=right['start']-left['end']
    char=chars[k][0];between=text[chars[k-1][0]:char]
    if (gap>=.36 and t-lastcut>=1.3 or any(c in between for c in '。！？!?') and t-lastcut>=.8 or t-lastcut>=7 and gap>=.08) and end-t>=.65:
     cuts.append((char,t));lastcut=t;lastchar=char
  parts=[];a=0;t=start
  for b,u in cuts+[(len(text),end)]:
   piece=text[a:b].strip()
   if piece and u>t:parts.append(dict(start=round(t,3),end=round(u,3),text=piece,originalSegment=i,avg_logprob=s.get('avg_logprob',0),no_speech_prob=s.get('no_speech_prob',0)))
   a=b;t=u
  for part in parts:
   part['originalJapanese']=part['text']
   for old,new in fixes.get(ep,{}).get(str(i),[]):part['text']=part['text'].replace(old,new)
  result.extend(parts)
 # Any recovered audio gap rows are explicitly reviewed before inclusion.
 extra=w/f'extra{ep}.json'
 if extra.exists():result.extend(json.loads(extra.read_text()))
 result.sort(key=lambda s:s['start'])
 for i,s in enumerate(result):s['id']=i
 p=w/f'e{ep}.segments.json';p.write_text(json.dumps(result,ensure_ascii=False,indent=2))
 print(ep,len(result),'clips; long:',[(s['id'],round(s['end']-s['start'],1),s['text']) for s in result if s['end']-s['start']>10])
