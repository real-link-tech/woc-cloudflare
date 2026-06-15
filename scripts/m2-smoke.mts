import WebSocket from 'ws';
import { createWocDb, HyperdriveConn } from '../src/worker/db';
import { signPlayToken } from '../src/worker/play-token';
const DB=process.env.DATABASE_URL!, SEC=process.env.PLAY_SESSION_SIGNING_SECRET!;
const db=createWocDb(new HyperdriveConn(DB)); const user=`m2smoke_${Date.now()%100000}`;
const c=await db.createCharacter(user,`Qq${Date.now()%9999}`,'warrior','Claudemoon');
const tok=await signPlayToken({userId:user,characterId:c.id},SEC,120);
const ws=new WebSocket(`wss://woc-dev.ipio.ai/ws?token=${encodeURIComponent(tok)}&realm=Claudemoon`);
let pid=-1, snaps=0, selfKeys:string[]=[], errored='';
ws.on('message',(r)=>{const m=JSON.parse(String(r));
  if(m.t==='hello'){pid=m.pid; ['tab','targetNearest','attack','accept','prestige','market_collect'].forEach(cmd=>ws.send(JSON.stringify({t:'cmd',cmd,quest:'x'})));}
  if(m.t==='error') errored=m.error;
  if(m.t==='snap'){snaps++; if(m.self) selfKeys=Object.keys(m.self);}});
await new Promise(r=>setTimeout(r,3500));
ws.close(); await db.end();
const need=['qlog','qdone','party','marks','trade','duel','arena','market','tal','cds','buyback','milestones'];
const missing=need.filter(k=>!selfKeys.includes(k));
console.log('RESULT '+JSON.stringify({pid,snaps,errored,selfKeyCount:selfKeys.length,missingFields:missing}));
process.exit(pid>0&&snaps>0&&!errored&&missing.length===0?0:1);
