import fs from 'fs';
const cl=p=>Math.min(.995,Math.max(.005,p));
for(const f of process.argv.slice(2)){const B=JSON.parse(fs.readFileSync(f)).B26;const R=B.players.filter(r=>r.pbp2New!=null);
 let ll=0,lc=0;for(const r of R){const c=.5*(.7*r.pbp2New+.3*(r.driveNew||0))+.5*(r.model??(.7*r.pbp2New+.3*(r.driveNew||0)));ll-=r.y?Math.log(cl(r.pbp2New)):Math.log(1-cl(r.pbp2New));lc-=r.y?Math.log(cl(c)):Math.log(1-cl(c));}
 let h=0,g=0,sh=0,sn=0;for(const G of B.games){const pk=G.picks.pbp2New;if(!pk)continue;g++;h+=pk.reduce((a,p)=>a+p.hit,0);const sc=new Set((G.actual||[]).map(x=>x.n));for(const l of G.surprise?.pbp2New?.ls||[]){sn++;sh+=sc.has(l.n)?1:0;}}
 console.log(f.replace('/tmp/','').padEnd(28),(h/g).toFixed(3),(ll/R.length).toFixed(5),'card',(lc/R.length).toFixed(5),'surprise',`${sh}/${sn}`,(sh/sn).toFixed(3));}
