import WebSocket from 'ws';
import { createWocDb, HyperdriveConn } from '../src/worker/db';
import { signPlayToken } from '../src/worker/play-token';
const DB=process.env.DATABASE_URL!, SEC=process.env.PLAY_SESSION_SIGNING_SECRET!;
const db=createWocDb(new HyperdriveConn(DB)); const user=`build_${Date.now()%100000}`;
const ltr=()=>String.fromCharCode(97+Math.floor(Math.random()*26));
const A=await db.createCharacter(user,'Bb'+Array.from({length:6},ltr).join(''),'warrior','Claudemoon');
const tok=(c:any)=>signPlayToken({userId:user,characterId:c.id},SEC,120);
function conn(label:string,t:string){const ws=new WebSocket(`wss://woc-dev.ipio.ai/ws?token=${encodeURIComponent(t)}&realm=Claudemoon`);
  const st:any={ws,pid:-1,objsOnConnect:null,liveAdds:[]};
  ws.on('message',(r)=>{const m=JSON.parse(String(r));
    if(m.t==='hello')st.pid=m.pid;
    if(m.t==='world_objects')st.objsOnConnect=m.list.map((o:any)=>({id:o.id,name:o.name,x:o.x,glb:o.glbUrl}));
    if(m.t==='world_object'&&m.op==='add')st.liveAdds.push({id:m.obj.id,name:m.obj.name});});
  return st;}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const a=conn('A',await tok(A)); await sleep(1500);
// A places an oak tree
a.ws.send(JSON.stringify({t:'cmd',cmd:'place_object',ipAssetId:'ipasset_test',glbUrl:'https://assets.ipio.ai/test/oak.glb',name:'Oak Tree',x:12,y:0,z:-5,rot:0.5,scale:2}));
await sleep(1200);
// B connects → should receive the placed object in world_objects
const b=conn('B',await tok(A)); await sleep(2000);
// A places a second object while B is connected → B should get a live add
a.ws.send(JSON.stringify({t:'cmd',cmd:'place_object',ipAssetId:'ipasset_test2',glbUrl:'https://assets.ipio.ai/test/rock.glb',name:'Rock',x:-8,y:0,z:3,rot:0,scale:1}));
await sleep(1500);
a.ws.close(); b.ws.close();
// verify persistence in the DB
const stored = await db.loadWorldState<any[]>('Claudemoon','world_objects');
const mine = (stored||[]).filter(o=>o.id.startsWith(`wo_${A.id}_`));
await sleep(200);
console.log('BUILD '+JSON.stringify({
  bSawOnConnect: b.objsOnConnect?.filter((o:any)=>o.name==='Oak Tree').map((o:any)=>o.name),
  bLiveAdds: b.liveAdds.map((x:any)=>x.name),
  persistedCount: mine.length, persistedNames: mine.map(o=>o.name)
}));
process.exit(0);
