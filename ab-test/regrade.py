import json, glob, os, sys
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__))); import abrun
rows=[json.loads(l) for l in open('results.jsonl')]
def final_text(sid):
    fs=glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}.jsonl'))
    last=None
    for l in open(fs[0]):
        o=json.loads(l)
        if o.get('type')=='assistant' and not o.get('isSidechain'):
            c=o['message'].get('content')
            t=''.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text') if isinstance(c,list) else ''
            if t: last=t
    return last or ''
changed=0
for r in rows:
    if r['task'] in ('audit',):
        d=f"{abrun.RUNS}/{r['task']}-{r['arm']}-{r['rep']}"
        txt=final_text(r['session_id'])
        ok,det=abrun.grade(r['task'],d,txt,None)
        if ok!=r['pass']: changed+=1
        r['pass'],r['details'],r['result']=ok,det,txt
        print(r['task'],r['arm'],r['rep'],ok,det)
json.dump(rows,open('results.regraded.json','w'),ensure_ascii=False)
with open('results.jsonl','w') as f:
    for r in rows: f.write(json.dumps(r,ensure_ascii=False)+'\n')
print('changed',changed)
