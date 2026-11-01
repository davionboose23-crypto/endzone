import json,re,numpy as np,sys
nm=lambda s: re.sub(r'[^a-z]','',re.sub(r'\b(jr|sr|ii|iii|iv)\b','',str(s).lower()))
R=[json.loads(l) for l in open(''+(__import__('sys').argv[1] if len(__import__('sys').argv)>1 else '/tmp/t99_rows.jsonl')+'')]
RO=json.load(open('/workspace/endzone/archive/sim/rotobot-feat-2026.json'));NF=json.load(open('/workspace/endzone/archive/sim/rzfeat-2026.json'))
cl=lambda p:np.clip(p,.005,.995);lg=lambda p:np.log(cl(p)/(1-cl(p)))
def feats(r):
  k=f"{r['w']}|{r['team']}|{nm(r['name'])}";a=RO.get(k,{});b=NF.get(k,{});te=r['pos'] in('TE','RB')
  return {'hT':a.get('hT',0)*a.get('hTn',0)/(a.get('hTn',0)+4)*te,'hS':a.get('hS',0)*te,'glC':a.get('glC',0),'c5':b.get('c5',0),'t10':b.get('t10',0),'c':b.get('c',0),'t':b.get('t',0)}
F=[feats(r) for r in R];y=np.array([r['y'] for r in R]);m=np.array([r['model'] for r in R]);w=np.array([r['w'] for r in R])
print('rows',len(R),'roto-covered',sum(1 for f in F if f['hS']>0 or f['glC']>0))
def fit(X,yy,lam=2.0):
  b=np.zeros(X.shape[1]);b[0]=1
  for _ in range(30):
    q=1/(1+np.exp(-X@b));g=X.T@(yy-q);H=(X*(q*(1-q))[:,None]).T@X;pen=np.full(len(b),lam);pen[1]=1e-3;pr=b.copy();pr[0]-=1
    g-=pen*pr;H+=np.diag(pen);b+=np.linalg.solve(H,g)
  return b
sets={'none':[], 'recal':[], 'roto(hT,hS,glC)':['hT','hS','glC'], 'nflverse(c,t,c5,t10)':['c','t','c5','t10'], 'both':['hT','hS','glC','c','t','c5','t10'], 'hT only':['hT']}
gid=np.array([r['gid'] for r in R])
for nmS,ks in sets.items():
  q=m.copy()
  if nmS!='none':
    X=np.column_stack([lg(m),np.ones(len(m))]+[np.array([f[k] for f in F]) for k in ks])
    for W in sorted(set(w)):
      tr=w<W
      if tr.sum()<300: continue
      b=fit(X[tr],y[tr]);te=w==W;q[te]=1/(1+np.exp(-X[te]@b))
  qq=cl(q);ll=-np.mean(y*np.log(qq)+(1-y)*np.log(1-qq));br=np.mean((q-y)**2)
  h=0;G=sorted(set(gid))
  for g in G:
    ix=np.where(gid==g)[0];top=ix[np.argsort(-q[ix])[:4]];h+=y[top].sum()
  print(f"{nmS:24s} hits {h/len(G):.3f} LL {ll:.5f} Brier {br:.5f}")
