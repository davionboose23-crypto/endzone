import pandas as pd, numpy as np
from sklearn.linear_model import LogisticRegression
D=pd.read_csv('surp.csv'); D=D[D.rk>=5].copy()
lg=lambda p: np.log(np.clip(p,1e-3,.999)/(1-np.clip(p,1e-3,.999)))
D['la']=lg(D['any'])
for p in ['WR','TE','QB']: D['is'+p]=(D.pos==p).astype(int)
D['rz2c']=D.rz2.clip(0,12); D['opTrc']=D.opTr.clip(-10,10)
sets={'cal':['la'],'pos':['la','isWR','isTE','isQB'],'full':['la','isWR','isTE','isQB','rz2c','opTrc','snapTr','newRole','snap','tmTd'],'trend':['la','rz2c','opTrc','snapTr','newRole']}
def ll(y,p): p=np.clip(p,1e-4,1-1e-4); return -np.mean(y*np.log(p)+(1-y)*np.log(1-p))
for C in [0.3,1.0]:
 for nmS,F in sets.items():
  for seed in sorted(D.seed.unique()):
    X=D[D.seed==seed].copy(); X['q']=np.nan
    for W in sorted(X.W.unique()):
      tr=X[X.W<W]
      if len(tr)<400 or tr.y.sum()<20: X.loc[X.W==W,'q']=X.loc[X.W==W,'any']; continue
      m=LogisticRegression(C=C,max_iter=500).fit(tr[F],tr.y); X.loc[X.W==W,'q']=m.predict_proba(X.loc[X.W==W,F])[:,1]
    E=X[X.W>=3]
    def box(col):
      b=E.sort_values(col,ascending=False).groupby('gid').head(3); g=b.groupby('gid').y.max(); return g.mean(), b.y.mean()
    bb,bp=box('any'); nb,npk=box('q')
    print(f"C={C} {nmS:6s} s{seed} games={E.gid.nunique()} box base {bb:.3f}/{bp:.3f} new {nb:.3f}/{npk:.3f}  LL base {ll(E.y,E['any']):.5f} new {ll(E.y,E.q):.5f}")
