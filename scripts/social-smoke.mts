import WebSocket from 'ws';
import { createWocDb, HyperdriveConn } from '../src/worker/db';
import { signPlayToken } from '../src/worker/play-token';
const DB=process.env.DATABASE_URL!, SEC=process.env.PLAY_SESSION_SIGNING_SECRET!;
const db=createWocDb(new HyperdriveConn(DB)); const user=`soc_${Date.now()%100000}`;
const ltr=()=>String.fromCharCode(97+Math.floor(Math.random()*26));
const nm=(p:string)=>p+Array.from({length:6},ltr).join('');
const A=await db.createCharacter(user,nm('Aa'),'warrior','Claudemoon');
const B=await db.createCharacter(user,nm('Bb'),'priest','Claudemoon');
const mk=(c:any)=>signPlayToken({userId:user,characterId:c.id},SEC,120);
function conn(label:string,tok:string){const ws=new WebSocket(`wss://woc-dev.ipio.ai/ws?token=${encodeURIComponent(tok)}&realm=Claudemoon`);
  const st:any={label,ws,pid:-1,social:null,chats:[],invites:[],logs:[],closed:''};
  ws.on('close',(c,r)=>st.closed=`${c} ${r}`);
  ws.on('message',(raw)=>{const m=JSON.parse(String(raw));
    if(m.t==='hello')st.pid=m.pid;
    if(m.t==='__debug')st.dbg=m;if(m.t==='__dbgacc')st.dbgacc=m;if(m.t==='social')st.social={friends:(m.friends||[]).map((f:any)=>f.name),guild:m.guild?{name:m.guild.name,members:m.guild.members.map((x:any)=>x.name)}:null,blocks:(m.blocks||[]).length};
    if(m.t==='events')for(const e of m.list){if(e.type==='chat')st.chats.push(`${e.channel}:${e.from}:${e.text}`);if(e.type==='guildInvite'){st.invites.push(e.guildName);st.ws.send(JSON.stringify({t:'cmd',cmd:'guild_accept'}));}if(e.type==='log')st.logs.push(e.text);if(e.type==='error')st.logs.push('ERR:'+e.text);}});
  return st;}
const a=conn('A',await mk(A)), b=conn('B',await mk(B));
const send=(s:any,o:any)=>s.ws.send(JSON.stringify(o));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
await sleep(1500);
send(a,{t:'cmd',cmd:'friend_add',name:B.name}); await sleep(800);
send(a,{t:'cmd',cmd:'guild_create',name:'Guild'+Array.from({length:8},ltr).join('')}); await sleep(900);
send(a,{t:'cmd',cmd:'guild_invite',name:B.name}); await sleep(900);
await sleep(6000); send(a,{t:'cmd',cmd:'chat',text:'/g hello after join'}); await sleep(2500); a.ws.close(); b.ws.close(); await db.end(); await sleep(200);
console.log('SOCIAL '+JSON.stringify({
  aPid:a.pid,bPid:b.pid,aClosed:a.closed,bClosed:b.closed,
  aFriends:a.social?.friends, aGuild:a.social?.guild?.name, aGuildMembers:a.social?.guild?.members, aLogs:a.logs, bLogs:b.logs,
  bInvites:b.invites, bErrLogs:b.logs, bSocial:b.social, bGuildChat:b.chats.filter((c:string)=>c.startsWith('guild:')), bDbg:b.dbg, bDbgAcc:b.dbgacc
}));
process.exit((a.pid>0&&b.pid>0&&!a.closed&&!b.closed)?0:1);
