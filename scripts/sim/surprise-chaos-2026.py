import pandas as pd, numpy as np, re
nm=lambda s: re.sub(r'[^a-z]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b','',str(s).lower()))
pb=pd.read_csv('/tmp/pbp/pbp_2026.csv.gz',low_memory=False); pb=pb[pb.season_type=='REG']
gm=pb.groupby('game_id').agg(week=('week','first'),home=('home_team','first'),away=('away_team','first'),hs=('home_score','max'),as_=('away_score','max'),roof=('roof','first'),temp=('temp','first'),wind=('wind','first')).reset_index()
pl=pb[(pb.play_type.isin(['pass','run']))]
tw=pl.groupby(['week','posteam']).agg(n=('play_id','size'),exp=('yards_gained',lambda x:(x>=20).sum())).reset_index()
# per team-week points for/against
rows=[]
for g in gm.itertuples(): rows+= [(g.week,g.home,g.hs,g.as_),(g.week,g.away,g.as_,g.hs)]
P=pd.DataFrame(rows,columns=['week','tm','pf','pa'])
# rz TD allowed by def, pass TD share allowed
rzd=pb[(pb.yardline_100<=20)&pb.play_type.isin(['pass','run'])]
drv=rzd.groupby(['week','defteam','game_id','drive']).touchdown.max().reset_index()
tdp=pb[(pb.touchdown==1)&(pb.td_team==pb.posteam)&((pb.rush==1)|(pb.pass_attempt==1))]
def prior(W,tm):
  p=P[(P.week<W)&(P.tm==tm)]; t=tw[(tw.week<W)&(tw.posteam==tm)]; d=drv[(drv.week<W)&(drv.defteam==tm)]; q=tdp[(tdp.week<W)&(tdp.defteam==tm)]
  return dict(pf=p.pf.mean(),pa=p.pa.mean(),pace=t.n.mean(),expr=t.exp.sum()/max(1,t.n.sum()),rzTdA=d.touchdown.mean() if len(d) else np.nan,passTdA=(q.pass_attempt==1).mean() if len(q) else np.nan)
G={}
for g in gm.itertuples():
  if g.week<3: continue
  h,a=prior(g.week,g.home),prior(g.week,g.away)
  G[(g.week,g.home)]=dict(home=1,gap=abs((h['pf']-h['pa'])-(a['pf']-a['pa'])),totF=h['pf']+a['pf']+h['pa']+a['pa'],pace=h['pace']+a['pace'],expr=h['expr']+a['expr'],oppRz=a['rzTdA'],oppPass=a['passTdA'],oppPa=a['pa'],dome=int(g.roof in('dome','closed')),wind=g.wind,temp=g.temp)
  G[(g.week,g.away)]=dict(G[(g.week,g.home)],home=0,oppRz=h['rzTdA'],oppPass=h['passTdA'],oppPa=h['pa'])
D=pd.read_csv('/tmp/a423/surp.csv'); D=D[D.W>=3]
F=pd.DataFrame([G.get((w,t),{}) for w,t in zip(D.W,D.team)],index=D.index); D=pd.concat([D,F],axis=1)
# teammate starter out: same team/pos player with prior mean snap>=.6 & >=2 games, no snap row this week
sn=pd.read_csv('/workspace/endzone/archive/snaps/snap_counts_2026.csv'); sn=sn[sn.game_type=='REG']; sn['nm']=sn.player.map(nm)
out=set()
for W in range(3,int(sn.week.max())+1):
  pr=sn[sn.week<W].groupby(['team','position','nm']).offense_pct.agg(['mean','size']); cur=set(zip(sn[sn.week==W].team,sn[sn.week==W].nm))
  for (t,p,n),r in pr.iterrows():
    if r['mean']>=.6 and r['size']>=2 and (t,n) not in cur and t in {x for x,_ in cur}: out.add((W,t,p))
D['mateOut']=[int((w,t,p) in out) for w,t,p in zip(D.W,D.team,D.pos)]
O=D[(D.rk>=5)&D.pos.isin(['RB','WR','TE'])].copy(); base=O.y.mean(); print('n',len(O),'rate',round(base,4),'pred',round(O['any'].mean(),4))
def show(c,q=True):
  k=pd.qcut(O[c].rank(method='first'),4,labels=False) if q else O[c]
  g=O.groupby(k); t=pd.DataFrame({'n':g.size(),'rate':g.y.mean(),'pred':g['any'].mean()}); t['lift']=t.rate/base; t['resid']=t.rate-t.pred; print('\n==',c); print(t.round(3).to_string())
for c in ['gap','totF','pace','expr','oppRz','oppPass','oppPa','temp']: show(c)
for c in ['home','dome','mateOut']: show(c,False)
# chaos index = z(totF)+z(expr)+z(gap)
z=lambda s:(s-s.mean())/s.std()
O['chaos']=z(O.totF)+z(O.expr)+z(O.gap); show('chaos')
O.to_csv('/tmp/a423/chaos.csv',index=False)
