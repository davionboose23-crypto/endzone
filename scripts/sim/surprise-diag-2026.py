import pandas as pd, numpy as np, json, re, sys
nm=lambda s: re.sub(r'[^a-z]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b','',str(s).lower()))
pb=pd.read_csv('/tmp/pbp/pbp_2026.csv.gz',low_memory=False); pb=pb[pb.season_type=='REG']
ro=pd.read_csv('/tmp/pbp/roster_2026.csv'); g2n=dict(zip(ro.gsis_id,ro.full_name))
pas=pb[(pb.pass_attempt==1)&(pb.sack!=1)&pb.receiver_player_id.notna()].copy(); pas['nm']=pas.receiver_player_id.map(lambda x: nm(g2n.get(x,''))); pas['tm']=pas.posteam
rus=pb[(pb.rush==1)&pb.rusher_player_id.notna()].copy(); rus['nm']=rus.rusher_player_id.map(lambda x: nm(g2n.get(x,''))); rus['tm']=rus.posteam
def wk(D,f=None):
  d=D if f is None else D[f(D)]; return d.groupby(['week','tm','nm']).size()
U=pd.DataFrame({'tg':wk(pas),'ca':wk(rus),'rz':wk(pas,lambda d:d.yardline_100<=20).add(wk(rus,lambda d:d.yardline_100<=20),fill_value=0)}).fillna(0)
U['op']=U.tg+U.ca
sn=pd.read_csv('/workspace/endzone/archive/snaps/snap_counts_2026.csv'); sn=sn[sn.game_type=='REG']; sn['nm']=sn.player.map(nm)
S=sn.set_index(['week','team','nm']).offense_pct
# TD type per scorer-game (for characterization)
td=pb[(pb.touchdown==1)&pb.td_player_id.notna()&(pb.td_team==pb.posteam)&((pb.rush==1)|(pb.pass_attempt==1))].copy()
td['nm']=td.td_player_id.map(lambda x: nm(g2n.get(x,''))); td['typ']=np.where(td.yards_gained>=20,'long20+',np.where(td.rush==1,np.where(td.yardline_100<=5,'shortRush<=5','rush6-20'),np.where(td.yardline_100<=20,'rzPass','pass21+')))
TT=td.groupby(['week','posteam','nm']).typ.first().to_dict()
fin=pb.groupby(['week','posteam']).agg(pf=('posteam_score_post','max'),pa=('defteam_score_post','max')).to_dict('index')
rows=[]
for f in sys.argv[1:]:
  seed=re.search(r'-(\d+)\.dump',f).group(1); dd=[r for r in json.load(open(f)) if r.get('eng')=='pbp2New']
  for g in {(r['W'],r['gid']) for r in dd}:
    G=[(r,p) for r in dd if (r['W'],r['gid'])==g for p in r['pl']]
    G.sort(key=lambda x:-x[1]['any'])
    for rk,(r,p) in enumerate(G,1):
      W=r['W']; t=r['team']; k=nm(p['n']); h=[U.loc[(w,t,k)] if (w,t,k) in U.index else None for w in range(1,W)]
      hv=[x for x in h if x is not None]; op=[x.op for x in hv]; rzz=[x.rz for x in hv]
      last2=lambda a: np.mean(a[-2:]) if a else 0; mean=lambda a: np.mean(a) if a else 0
      sp=[S.get((w,t,k)) for w in range(1,W)]; sp=[x for x in sp if x is not None and not np.isnan(x)]
      # teammates same pos with high prior snaps not active this week
      rows.append(dict(seed=seed,W=W,gid=r['gid'],team=t,n=p['n'],pos=p['pos'],rk=rk,any=p['any'],y=int(p['td']>0),
        opTr=last2(op)-mean(op),rzTr=last2(rzz)-mean(rzz),rz2=sum(rzz[-2:]),snapTr=(np.mean(sp[-2:])-np.mean(sp)) if sp else 0,snap=np.mean(sp) if sp else 0,
        newRole=int(len(sp)>=3 and np.mean(sp[-2:])-np.mean(sp[:-2])>0.15),gp=len(hv),typ=TT.get((W,t,k)),
        tmTd=sum(q['any'] for rr,q in G if rr['team']==t), pf=fin.get((W,t),{}).get('pf'),pa=fin.get((W,t),{}).get('pa')))
D=pd.DataFrame(rows); D.to_csv('/tmp/a423/surp.csv',index=False); print(len(D))
