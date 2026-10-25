import json, statistics as st, sys, collections
rows=[json.loads(l) for l in open(sys.argv[1])]
by=collections.defaultdict(list)
for r in rows: by[(r['task'],r['arm'])].append(r)
def tot(r): t=r.get('tokens') or {}; return sum(t.values())
tasks=sorted({r['task'] for r in rows}, key=lambda t: ['qa','inventory','triage','bugfix','feature','rename','audit','logdiff'].index(t))
print(f"{'task':<10} arm  n pass  cost_mean   tokens_mean  out_mean turns tools  notes denies")
ARMS=sorted({r['arm'] for r in rows}); agg={a:[] for a in ARMS}
for t in tasks:
    for a in ARMS:
        rs=by[(t,a)]
        if not rs: continue
        agg[a]+=rs
        c=[r['cost_usd'] or 0 for r in rs]; k=[tot(r) for r in rs]; o=[(r.get('tokens') or {}).get('outputTokens',0) for r in rs]
        tc=[r.get('transcript',{}).get('tool_calls',0) for r in rs]; nt=[r.get('transcript',{}).get('hook_notes',0) for r in rs]; dn=[r.get('transcript',{}).get('denies',0) for r in rs]
        print(f"{t:<10} {a}   {len(rs)} {sum(r['pass'] for r in rs)}/{len(rs)}  {st.mean(c):.4f}    {st.mean(k):>9.0f}   {st.mean(o):>6.0f}  {st.mean([r.get('turns') or 0 for r in rs]):>4.1f}  {st.mean(tc):>4.1f}  {sum(nt):>4} {sum(dn):>4}")
for a in ARMS:
    rs=agg[a]
    print(a, 'total cost', round(sum(r['cost_usd'] or 0 for r in rs),4), 'tokens', sum(tot(r) for r in rs), 'pass', sum(r['pass'] for r in rs), '/', len(rs))
