import pg from "pg"; import { readFileSync } from "node:fs";
const DB = readFileSync(new URL("./.env", import.meta.url),"utf8").split("\n").find(l=>l.startsWith("DATABASE_URL=")).slice(13);
const c=new pg.Client({connectionString:DB,ssl:{rejectUnauthorized:false}}); await c.connect();
const o="0xc53ede70b11b8d477eeefed160fe1227cd610891";
let last="";
const t0=Date.now();
while(Date.now()-t0 < 300000){
  const j=await c.query("select job_id,status,verdict,blocked_by,acceptance from jobs where owner_addr=$1 order by updated_at desc limit 1",[o]);
  const r=j.rows[0];
  if(r){
    const line=`${r.job_id.slice(0,8)} ${r.status} verdict=${r.verdict} blk=${r.blocked_by}`;
    if(line!==last){ console.log(new Date().toISOString().slice(11,19), line); if(r.acceptance && !r.acceptance.passed) console.log("   floor failures:", JSON.stringify(r.acceptance.failures)); last=line; }
    if(["awaiting_approval","settled","rejected","denied","failed"].includes(r.status) && r.status!=="originated"){
      if(["awaiting_approval","settled"].includes(r.status)){ console.log(">>> REACHED",r.status,"— fix WORKS"); break; }
      if(["rejected","denied","failed"].includes(r.status)){ console.log(">>> job",r.status,"(will re-originate; keep watching)"); }
    }
  }
  await new Promise(r=>setTimeout(r,12000));
}
await c.end();
