import pandas as pd, numpy as np, json, re
nm=lambda s: re.sub(r'[^a-z]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b','',str(s).lower()))
pb=pd.read_csv('/tmp/pbp/pbp_2026.csv.gz',low_memory=False); pb=pb[pb.season_type=='REG']
ro=pd.read_csv('/tmp/pbp/roster_2026.csv'); g2n=dict(zip(ro.gsis_id,ro.full_name)); g2p=dict(zip(ro.gsis_id,ro.position))
pas=pb[(pb.pass_attempt==1)&(pb.sack!=1)&pb.receiver_player_id.notna()&(pb.yardline_100<=20)].copy(); rus=pb[(pb.rush==1)&pb.rusher_player_id.notna()&(pb.yardline_100<=20)].copy()
pas['id']=pas.receiver_player_id; rus['id']=rus.rusher_player_id
sn=pd.read_csv('/workspace/endzone/archive/snaps/snap_counts_2026.csv'); sn=sn[sn.game_type=='REG']; sn['nm']=sn.player.map(nm)
K={'RB':4,'WR':10,'TE':10,'QB':6}
out={}
for W in range(2,int(pb.week.max())+2):
  sp=sn[sn.week<W].groupby(['team','nm']).offense_pct.mean()
  f={}
  for lab,D,mx in [('c',rus,20),('c10',rus,10),('c5',rus,5),('t',pas,20),('t10',pas,10)]:
    d=D[(D.week<W)&(D.yardline_100<=mx)]
    for hl,suf in [(None,''),(2,'R')]:
      if suf and lab not in('c','t'): continue
      w=np.ones(len(d)) if hl is None else 0.5**((W-1-d.week.values)/hl)
      d2=d.assign(w=w); a=d2.groupby(['posteam','id']).w.sum(); b=d2.groupby('posteam').w.sum()
      for (t,i),v in a.items(): f.setdefault((t,i),{})[lab+suf]=v/b[t]
      if not suf and lab in('c','t'):
        # position-specific shrink: share toward pos mean with k pseudo-events
        n=d2.groupby('posteam').w.sum()
        for (t,i),v in a.items():
          p=g2p.get(i,'WR'); pm={'c':{'RB':.35,'QB':.12,'WR':.02,'TE':.01},'t':{'RB':.05,'QB':0,'WR':.12,'TE':.12}}[lab].get(p,.02)
          f[(t,i)][lab+'K']=(v+K.get(p,8)*pm)/(n[t]+K.get(p,8))
  ap=pb[(pb.pass_attempt==1)&(pb.sack!=1)&pb.receiver_player_id.notna()&(pb.week<W)].copy()
  ap['ay']=ap.air_yards.fillna(0).clip(lower=0); ap['ez']=(ap.air_yards>=ap.yardline_100).astype(float)
  for col,lab in [('ay','air'),('ez','ez')]:
    a=ap.groupby(['posteam','receiver_player_id'])[col].sum(); b=ap.groupby('posteam')[col].sum()
    for (t,i),v in a.items():
      if b[t]>0: f.setdefault((t,i),{})[lab]=v/b[t]
  for (t,i),v in f.items():
    k=nm(g2n.get(i,'')); v['snap']=float(sp.get((t,k),np.nan)) if (t,k) in sp else None
    out[f'{W}|{t}|{k}']={a:(round(b,4) if b is not None else None) for a,b in v.items()}
  for (t,k),v in sp.items():
    out.setdefault(f'{W}|{t}|{k}',{'snap':round(float(v),4)})
json.dump(out,open('/workspace/endzone/archive/sim/rzfeat-2026.json','w'))
print(len(out), list(out.items())[100])
