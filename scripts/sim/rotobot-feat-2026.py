# t98u: walk-forward RotoBot Stat Explorer features (non-odds). Week W uses weeks 1..W-1; week 8 RotoBot treated as missing.
import pandas as pd,json,re,os
nm=lambda s: re.sub(r'[^a-z]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b','',str(s).lower()))
D='archive/rotobot';T={'LAR':'LA'}
def rd(k,w):
  f=f'{D}/{k}_w{w:02d}.csv'
  if w>=8 or not os.path.exists(f): return pd.DataFrame()
  r=pd.read_csv(f);r['Team']=r.Team.replace(T);r['nm']=r.Player.map(nm);r['w']=w;return r
out={}
for W in range(2,10):
  h=pd.concat([rd('rz_rec_heavy',w) for w in range(1,W)]);gr=pd.concat([rd('gl_rush',w) for w in range(1,W)])
  for lab,d,col in [('hT',h,'TGT'),('hS',h,'SNAPS'),('hTD',h,'TD'),('glC',gr,'ATT')]:
    if d.empty: continue
    a=d.groupby(['Team','nm'])[col].sum();b=d.groupby('Team')[col].sum()
    for (t,n),v in a.items():
      out.setdefault(f'{W}|{t}|{n}',{})[lab]=round(float(v/b[t]),4) if b[t]>0 else 0
      out[f'{W}|{t}|{n}'][lab+'n']=int(b[t])
json.dump(out,open('archive/sim/rotobot-feat-2026.json','w'))
print(len(out))
