import fs from 'fs';
const f=process.argv[2];const R=JSON.parse(fs.readFileSync(f)).B26.players.filter(r=>r.pbp2New!=null);
const cl=p=>Math.min(.995,Math.max(.005,p)),L=p=>Math.log(cl(p)/(1-cl(p))),S=x=>1/(1+Math.exp(-x));
const weeks=[...new Set(R.map(r=>r.w))].sort((a,b)=>a-b);const byG=new Map();for(const r of R)(byG.get(r.gid)||byG.set(r.gid,[]).get(r.gid)).push(r);
const nll=(rows,g)=>rows.reduce((s,r)=>{const q=cl(g(r.p));return s-(r.y?Math.log(q):Math.log(1-q))},0);
const fits={
 none:()=>p=>p,
 platt:rows=>{let best=[1,0],bl=1e18;for(let a=.5;a<=1.3001;a+=.025)for(let b=-1;b<=1.0001;b+=.025){const v=nll(rows,p=>S(a*L(p)+b));if(v<bl){bl=v;best=[a,b]}}const[a,b]=best;return p=>S(a*L(p)+b)},
 trim:rows=>{let bs=1,bt=.3,bl=1e18;for(const t of[.2,.25,.3,.35,.4])for(let s=.2;s<=1.0001;s+=.05){const v=nll(rows,p=>p>t?t+(p-t)*s:p);if(v<bl){bl=v;bs=s;bt=t}}return p=>p>bt?bt+(p-bt)*bs:p},
};
const comps={
 pbp:r=>r.pbp2New, card3:r=>.7*r.pbp2New+.3*(r.driveNew||0), card5:r=>.5*r.pbp2New+.5*(r.driveNew||0),
 ...Object.fromEntries([.2,.35,.5].flatMap(m=>[[`m${m}_c3`,r=>(1-m)*(.7*r.pbp2New+.3*(r.driveNew||0))+m*(r.model??r.pbp2New)],[`m${m}_c5`,r=>(1-m)*(.5*r.pbp2New+.5*(r.driveNew||0))+m*(r.model??r.pbp2New)]])),
};
const out=[];
for(const [cn,cf] of Object.entries(comps))for(const [fn,ff] of Object.entries(fits))for(const rank of cn.startsWith('m')?['pbp','blend']:['pbp']){
 let h=0,g=0,ll=0,n=0;
 for(const W of weeks){const tr=R.filter(r=>r.w<W).map(r=>({p:cf(r),y:r.y}));const map=(fn==='none'||tr.length<300)?(p=>p):ff(tr);
  for(const[gid,rs]of byG){if(rs[0].w!==W)continue;g++;const d=rs.map(r=>map(cf(r)));const key=rank==='pbp'?rs.map(r=>r.pbp2New):d;const top=rs.map((r,i)=>i).sort((a,b)=>key[b]-key[a]||d[b]-d[a]).slice(0,4);h+=top.filter(i=>rs[i].y).length;rs.forEach((r,i)=>{const q=cl(d[i]);ll-=r.y?Math.log(q):Math.log(1-q);n++})}}
 out.push(`${(cn+' '+fn+' rank:'+rank).padEnd(30)} ${(h/g).toFixed(3)} ${(ll/n).toFixed(5)}`);}
console.log(out.join('\n'));
