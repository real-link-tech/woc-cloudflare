// M1 live verification against the DEPLOYED worker (woc-dev.ipio.ai).
// Proves: Hyperdrive DB character load + play-token WS auth + DO sim loop +
// multiplayer snapshot visibility (player B sees player A move).
//
// Run:
//   DATABASE_URL=... PLAY_SESSION_SIGNING_SECRET=... npx tsx scripts/m1-live-verify.mts
import WebSocket from 'ws';
import { createWocDb } from '../src/worker/db';
import { signPlayToken } from '../src/worker/play-token';

const HOST = process.env.WOC_HOST ?? 'woc-dev.ipio.ai';
const REALM = 'Claudemoon';
const DB = process.env.DATABASE_URL!;
const SECRET = process.env.PLAY_SESSION_SIGNING_SECRET!;
if (!DB || !SECRET) { console.error('need DATABASE_URL + PLAY_SESSION_SIGNING_SECRET'); process.exit(2); }

function rand(n: number) { return Math.floor((Date.now() % 1e9) / 7 % 100000) + n; }

interface Conn { ws: WebSocket; pid: number; snaps: any[]; }

async function connect(label: string, token: string): Promise<Conn> {
  const ws = new WebSocket(`wss://${HOST}/ws?token=${encodeURIComponent(token)}&realm=${REALM}`);
  const conn: Conn = { ws, pid: -1, snaps: [] };
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label}: no hello in 10s`)), 10000);
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === 'hello') { conn.pid = m.pid; clearTimeout(to); console.log(`${label}: hello pid=${m.pid} seed=${m.seed}`); resolve(); }
      else if (m.t === 'snap') { conn.snaps.push(m); }
      else if (m.t === 'error') { clearTimeout(to); reject(new Error(`${label}: server error: ${m.error}`)); }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(new Error(`${label}: ws error ${e.message}`)); });
  });
  return conn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = createWocDb(DB);
  const user = `m1verify_${rand(0)}`;
  console.log(`creating 2 characters for ${user}...`);
  const a = await db.createCharacter(user, `Alpha${rand(1) % 1000}`, 'warrior', REALM);
  const b = await db.createCharacter(user, `Bravo${rand(2) % 1000}`, 'mage', REALM);
  console.log(`chars: A=${a.id} B=${b.id}`);
  const tokA = await signPlayToken({ userId: user, characterId: a.id }, SECRET, 120);
  const tokB = await signPlayToken({ userId: user, characterId: b.id }, SECRET, 120);

  const ca = await connect('A', tokA);
  const cb = await connect('B', tokB);

  // let both settle, then drive A forward for ~2.5s
  await sleep(500);
  cb.snaps.length = 0;
  console.log('driving A forward...');
  const drive = setInterval(() => {
    if (ca.ws.readyState === WebSocket.OPEN)
      ca.ws.send(JSON.stringify({ t: 'input', mi: { f: 1, b: 0, tl: 0, tr: 0, sl: 0, sr: 0, j: 0 } }));
  }, 50);
  await sleep(2500);
  clearInterval(drive);
  await sleep(300);

  // Did B's snapshots contain A's entity, and did it move?
  const aPositions: { x: number; z: number }[] = [];
  let bSawA = false;
  for (const snap of cb.snaps) {
    const ent = (snap.ents ?? []).find((e: any) => e.id === ca.pid);
    if (ent && typeof ent.x === 'number') { bSawA = true; aPositions.push({ x: ent.x, z: ent.z }); }
  }
  const first = aPositions[0], last = aPositions[aPositions.length - 1];
  const moved = first && last && (Math.hypot(last.x - first.x, last.z - first.z) > 1);
  console.log(`B received ${cb.snaps.length} snapshots; saw A in ${aPositions.length} of them.`);
  if (first && last) console.log(`A moved from (${first.x},${first.z}) to (${last.x},${last.z}) in B's view.`);

  ca.ws.close(); cb.ws.close(); await db.end();
  await sleep(200);

  const pass = ca.pid > 0 && cb.pid > 0 && bSawA && moved;
  console.log(pass ? '\n✅ M1 PASS: two players connected, B saw A spawn and move.'
                   : '\n❌ M1 FAIL: ' + JSON.stringify({ aPid: ca.pid, bPid: cb.pid, bSawA, moved }));
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('verify error:', e); process.exit(3); });
