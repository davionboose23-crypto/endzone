import fs from 'fs';
const f=process.argv[2]; const D=JSON.parse(fs.readFileSync(f)).filter(r=>r.eng==='pbp2New');
const out=[];const P=(...a)=>out.push(a.join(' '));const r3=x=>(+x).toFixed(3);
const rows=[];const prior=new Map();
D.sort((a,b)=>a.W-b.W);
for(const t of D){const pos={};const sorted=[...t.pl].sort((a,b)=>b.lam-a.lam||b.any-a.any);
 for(const p of sorted){const ps=p.pos==='FB'?'RB':p.pos;pos[ps]=(pos[ps]||0)+1;p.slot=ps+Math.min(pos[ps],ps==='WR'?4:3);}
 const ranks=[...t.pl].sort((a,b)=>b.any-a.any);ranks.forEach((p,i)=>p.rk=i+1);}
for(const t of D)for(const p of t.pl){const k=p.id;const pr=prior.get(k)||0;rows.push({...p,team:t.team,W:t.W,gid:t.gid,prior:pr,y:p.td>0?1:0});}
// prior TDs (weeks>=2 in dump)
{const acc=new Map();const byW=[...new Set(D.map(t=>t.W))].sort((a,b)=>a-b);for(const w of byW){for(const r of rows.filter(r=>r.W===w))r.prior=acc.get(r.id)||0;for(const r of rows.filter(r=>r.W===w))acc.set(r.id,(acc.get(r.id)||0)+r.td);}}
const cal=(name,key)=>{const g={};for(const r of rows){const k=key(r);if(k==null)continue;(g[k]=g[k]||{n:0,p:0,y:0,ll:0,et:0,at:0});const q=Math.min(.999,Math.max(1e-4,r.any));g[k].n++;g[k].p+=r.any;g[k].y+=r.y;g[k].ll-=r.y?Math.log(q):Math.log(1-q);g[k].et+=r.mt||0;g[k].at+=r.td;}
 P(`\n[${name}] key n predAny actAny ratio  simTD actTD  LLsum`);for(const [k,v] of Object.entries(g).sort((a,b)=>b[1].ll-a[1].ll))P(k.padEnd(8),v.n,r3(v.p/v.n),r3(v.y/v.n),(v.y/Math.max(1e-9,v.p)).toFixed(2),v.et.toFixed(1),v.at,v.ll.toFixed(1));};
cal('position',r=>r.pos==='FB'?'RB':r.pos);
cal('depth slot',r=>r.slot);
cal('prob bucket',r=>{const b=[.02,.05,.1,.2,.3,.4,.5,1];return '<'+b.find(x=>r.any<x);});
cal('sim rank in team',r=>r.rk<=6?'r'+r.rk:'r7+');
// team-level
const tg=D.map(t=>{const s=t.pl.reduce((a,p)=>a+(p.mt||0),0),a=t.pl.reduce((x,p)=>x+p.td,0),sr=t.pl.reduce((x,p)=>x+(p.mr||0),0),ar=t.pl.reduce((x,p)=>x+(p.rtd||0),0);const mean=t.hist.reduce((x,v,i)=>x+i*v,0);const sd=Math.sqrt(t.hist.reduce((x,v,i)=>x+v*(i-mean)**2,0));return {W:t.W,gid:t.gid,team:t.team,opp:t.gid.split('_').slice(2).find(x=>x!==t.team),s:s||mean,mean,sd,a,sr,ar,pa:t.hist[Math.min(11,a)]};});
const opp=new Map(tg.map(x=>[x.gid+x.team,x]));
P('\n[team TD totals] games',tg.length,'mean sim',r3(tg.reduce((a,x)=>a+x.s,0)/tg.length),'mean actual',r3(tg.reduce((a,x)=>a+x.a,0)/tg.length),'RMSE',r3(Math.sqrt(tg.reduce((a,x)=>a+(x.a-x.s)**2,0)/tg.length)),'corr',r3((()=>{const n=tg.length,ms=tg.reduce((a,x)=>a+x.s,0)/n,ma=tg.reduce((a,x)=>a+x.a,0)/n;let c=0,vs=0,va=0;for(const x of tg){c+=(x.s-ms)*(x.a-ma);vs+=(x.s-ms)**2;va+=(x.a-ma)**2;}return c/Math.sqrt(vs*va);})()),'mean sim sd',r3(tg.reduce((a,x)=>a+x.sd,0)/tg.length),'actual sd of resid',r3(Math.sqrt(tg.reduce((a,x)=>a+(x.a-x.s)**2,0)/tg.length)));
// PIT of team totals
{const pit=[0,0,0,0,0];for(const t of D){const a=t.pl.reduce((x,p)=>x+p.td,0);let c=0;for(let i=0;i<a;i++)c+=t.hist[i];const u=c+t.hist[Math.min(11,a)]*Math.random();pit[Math.min(4,Math.floor(u*5))]++;}P('team-total PIT quintiles (flat = calibrated spread)',pit.join(' '));}
// actual vs sim histogram
{const hs=new Array(8).fill(0),ha=new Array(8).fill(0);for(const t of D){t.hist.forEach((v,i)=>hs[Math.min(7,i)]+=v);ha[Math.min(7,t.pl.reduce((x,p)=>x+p.td,0))]++;}P('team TD count dist sim:',hs.map(x=>x.toFixed(1)).join(' '),'| actual:',ha.join(' '));}
const agg=(key,lab)=>{const g={};for(const x of tg){const k=key(x);(g[k]=g[k]||{n:0,s:0,a:0,sr:0,ar:0});g[k].n++;g[k].s+=x.s;g[k].a+=x.a;g[k].sr+=x.sr;g[k].ar+=x.ar;}
 P(`\n[${lab}] team n simTD actTD bias/g  z  | simRushTD actRush simRecTD actRec`);for(const [k,v] of Object.entries(g).sort((a,b)=>(b[1].a-b[1].s)-(a[1].a-a[1].s)))P(k.padEnd(4),v.n,v.s.toFixed(1),v.a,r3((v.a-v.s)/v.n),((v.a-v.s)/Math.sqrt(v.s)).toFixed(2),'|',v.sr.toFixed(1),v.ar,(v.s-v.sr).toFixed(1),v.a-v.ar);
 const ch=Object.values(g).reduce((a,v)=>a+(v.a-v.s)**2/v.s,0);P(`chi2 ${lab} =`,ch.toFixed(1),'df',Object.keys(g).length);};
agg(x=>x.team,'offense bias');agg(x=>x.opp,'defense (opponent) bias');
{const sr=tg.reduce((a,x)=>a+x.sr,0),ar=tg.reduce((a,x)=>a+x.ar,0),s=tg.reduce((a,x)=>a+x.s,0),a=tg.reduce((a,x)=>a+x.a,0);P('\nleague rush share sim',r3(sr/s),'actual',r3(ar/a),'| rush TD sim',sr.toFixed(1),'act',ar,'rec sim',(s-sr).toFixed(1),'act',a-ar);}
// decomposition: player-level LL into total vs allocation. For each team-game: actual scorers. Poisson-ish: player i's TD count ~ team N * share. Compare: LL with sim; LL with oracle team total (rescale each player's expected TDs to actual team total) ; LL with oracle allocation (actual shares, sim team total)
const pa=lam=>1-Math.exp(-lam);
let L={sim:0,oT:0,oA:0,simP:0},hitsS=0,hitsT=0,ng=0;
for(const t of D){const a=t.pl.reduce((x,p)=>x+p.td,0);const s=t.pl.reduce((x,p)=>x+(p.mt||0),0)||1;
 for(const p of t.pl){const q=v=>Math.min(.999,Math.max(1e-4,v));const y=p.td>0;const ll=v=>y?-Math.log(q(v)):-Math.log(1-q(v));
  L.sim+=ll(p.any);L.simP+=ll(pa(p.mt||0));L.oT+=ll(pa((p.mt||0)*a/s));L.oA+=ll(pa(a?(p.td/a)*s:0)*0+pa(s*(p.td/(a||1))));}}
P('\n[decomposition: roster-pool log-loss sums, both teams all games]');P('sim anytime',L.sim.toFixed(1),' poisson(sim mean)',L.simP.toFixed(1),' oracle team total (sim shares × actual team TDs)',L.oT.toFixed(1),' => team-total error worth',(L.simP-L.oT).toFixed(1));
// top-4 hits per game game-level: hits with oracle team totals
const games=[...new Set(D.map(t=>t.gid))];let h0=0,h1=0,h2=0;
for(const g of games){const ts=D.filter(t=>t.gid===g);const all=ts.flatMap(t=>{const a=t.pl.reduce((x,p)=>x+p.td,0);const s=t.pl.reduce((x,p)=>x+(p.mt||0),0)||1;return t.pl.map(p=>({p,o:pa((p.mt||0)*a/s),a}))});
 const top=k=>[...all].sort((x,y)=>k(y)-k(x)).slice(0,4).filter(x=>x.p.td>0).length;h0+=top(x=>x.p.any);h1+=top(x=>x.o);
 // oracle team-scoring flag: only teams' players ordered by sim within actual-TD teams
 h2+=Math.min(4,all.filter(x=>x.p.td>0).length);}
P('top4 hits/game: sim',r3(h0/games.length),' with oracle team TD totals',r3(h1/games.length),' ceiling (scorers available)',r3(h2/games.length));
// allocation: among actual TDs, share of actual TDs going to players by sim rank
{const rk={};let n=0;for(const t of D)for(const p of t.pl)if(p.td){const k=p.rk<=6?'r'+p.rk:'r7+';rk[k]=(rk[k]||0)+p.td;n+=p.td;}const ex={};for(const t of D){const s=t.pl.reduce((x,p)=>x+(p.mt||0),0)||1;const a=t.pl.reduce((x,p)=>x+p.td,0);for(const p of t.pl){const k=p.rk<=6?'r'+p.rk:'r7+';ex[k]=(ex[k]||0)+(p.mt||0)/s*a;}}
 P('\n[allocation given actual team TDs] rank: expected share of actual TDs vs actual share');for(const k of Object.keys(ex).sort())P(k,r3(ex[k]/n),r3((rk[k]||0)/n));}
// concentration: avg sim share of top player vs actual share of top-sim player's team TDs; entropy
{let e=0,c=0,n=0;for(const t of D){const a=t.pl.reduce((x,p)=>x+p.td,0);if(!a)continue;const s=t.pl.reduce((x,p)=>x+(p.mt||0),0)||1;const sh=t.pl.map(p=>(p.mt||0)/s).sort((x,y)=>y-x);e+=sh.slice(0,2).reduce((x,y)=>x+y,0);const top2=[...t.pl].sort((x,y)=>(y.mt||0)-(x.mt||0)).slice(0,2);c+=top2.reduce((x,p)=>x+p.td,0)/a;n++;}P('top-2 sim share of team TDs: predicted',r3(e/n),'actual',r3(c/n),'(teams with ≥1 TD,',n,')');}
// QB rushing
cal('QB rushing',r=>r.pos==='QB'?(r.slot==='QB1'?'QB1':'QBx'):null);
{const q=rows.filter(r=>r.pos==='QB');P('QB sim rushTD',q.reduce((a,r)=>a+(r.mr||0),0).toFixed(1),'actual QB TDs',q.reduce((a,r)=>a+r.td,0));}
// missed scorers profile: scorers with sim any<0.15
{const m=rows.filter(r=>r.y&&r.any<0.15),h=rows.filter(r=>r.y&&r.any>=0.15);const av=(A,f)=>r3(A.reduce((a,r)=>a+(f(r)||0),0)/Math.max(1,A.length));
 P('\n[scorers] missed (sim<15%) n',m.length,'vs found n',h.length);for(const [lab,f] of [['sim any',r=>r.any],['tgt/g',r=>r.tgt],['car/g',r=>r.car],['RZ car sh',r=>r.carRz],['RZ tgt sh',r=>r.tgtRz],['i10 car sh',r=>r.carI10],['prior TDs',r=>r.prior],['team rank',r=>r.rk]])P(lab.padEnd(10),av(m,f),av(h,f));
 const ps={};for(const r of m)ps[r.pos+(r.tgt+r.car<1?'-noUse':'')]=(ps[r.pos+(r.tgt+r.car<1?'-noUse':'')]||0)+1;P('missed by pos/usage',JSON.stringify(ps));
 const zero=m.filter(r=>r.any<0.02);P('scorers with sim<2%:',zero.length,zero.slice(0,25).map(r=>`${r.n}(${r.pos},${r.team},W${r.W},${r3(r.any)})`).join('; '));}
// worst games
{const gg=games.map(g=>{const ts=tg.filter(x=>x.gid===g);const pl=rows.filter(r=>r.gid===g);const top=[...pl].sort((a,b)=>b.any-a.any).slice(0,4);return {g,hits:top.filter(r=>r.y).length,tot:ts.map(x=>`${x.team} ${x.s.toFixed(1)}/${x.a}`).join(' '),miss:pl.filter(r=>r.y&&r.any<0.2).map(r=>r.n.split(' ').pop()+'('+r3(r.any)+')').join(',')};}).sort((a,b)=>a.hits-b.hits);
 P('\n[0-hit games]',gg.filter(x=>x.hits===0).length);for(const x of gg.filter(x=>x.hits===0))P(x.g,x.tot,'missed:',x.miss);}
console.log(out.join('\n'));
