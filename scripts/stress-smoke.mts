import WebSocket from 'ws';
import { createWocDb } from '../src/worker/db';
import { signPlayToken } from '../src/worker/play-token';
const DB=process.env.DATABASE_URL!, SEC=process.env.PLAY_SESSION_SIGNING_SECRET!;
const db=createWocDb(DB); const user=`stress_${Date.now()%100000}`;
const c=await db.createCharacter(user,`St${Date.now()%9999}`,'mage','Claudemoon');
const tok=await signPlayToken({userId:user,characterId:c.id},SEC,120);
const ws=new WebSocket(`wss://woc-dev.ipio.ai/ws?token=${encodeURIComponent(tok)}&realm=Claudemoon`);
let pid=-1,snaps=0,closed='';
ws.on('open',()=>{});
ws.on('close',(code,r)=>{closed=`code=${code} reason=${r}`;});
ws.on('message',(raw)=>{const m=JSON.parse(String(raw));
  if(m.t==='hello'){pid=m.pid;
    // spam a wide variety of commands rapidly
    const cmds=['tab','targetNearest','attack','cast','castSlot','interact','loot','pickup','accept','turnin','abandon','equip','use','discard','buy','sell','buyback','release','enter_dungeon','leave_dungeon','prestige','respec','market_collect','arena_queue','arena_leave'];
    let i=0;
    const spam=setInterval(()=>{for(let k=0;k<5;k++){const cmd=cmds[(i++)%cmds.length];ws.send(JSON.stringify({t:'cmd',cmd,id:9999,item:'bogus',ability:'bogus',slot:99,quest:'bogus',npc:9999,dungeon:'bogus',count:-1}));}
      ws.send(JSON.stringify({t:'input',mi:{f:1,tr:1}}));},20);
    setTimeout(()=>clearInterval(spam),5000);
  }
  if(m.t==='snap')snaps++;});
await new Promise(r=>setTimeout(r,7000));
ws.close(); await db.end();
console.log('STRESS '+JSON.stringify({pid,snaps,closed}));
process.exit(0);
