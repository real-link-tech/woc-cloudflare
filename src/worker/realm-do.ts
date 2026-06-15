// WorldRealmDurableObject — one realm's authoritative game world.
//
// This is the Cloudflare port of the Node `GameServer` (server/game.ts). It
// holds a single deterministic `Sim` in memory, accepts non-hibernating
// WebSocket players, runs a 20 Hz tick loop, and broadcasts wire-compatible
// snapshots that the existing client (src/net/online.ts) consumes unchanged.
//
// M1 scope: connect → spawn from a forwarded identity → move → other connected
// players see the movement. Combat/quests come "for free" because the Sim
// computes them internally; the DO only feeds input and serializes snapshots.
// Chat/party/trade/duel/social/market/quest/loadout commands are deferred to M2.
import { Sim, type CharacterState } from '../sim/sim';
import type { Entity, PlayerClass } from '../sim/types';
import { DT } from '../sim/types';
import { parseMoveInputFrame } from '../sim/move_input';
import { createWocDb, type WocDb } from './db';
import { round2, wireEntity } from './wire';

export interface WorldEnv {
  HYPERDRIVE: { connectionString: string };
}

interface Conn {
  socket: WebSocket;
  pid: number;
  userId: string;
  characterId: number;
  realm: string;
  name: string;
  dbSessionId: number | null;
  lastSave: number;
}

// Squared interest radius: a player only receives entities within 100 units.
const INTEREST_RADIUS = 100;
const INTEREST_RADIUS_SQ = INTEREST_RADIUS * INTEREST_RADIUS;

function withinInterest(p: Entity, e: Entity): boolean {
  const dx = p.pos.x - e.pos.x;
  const dz = p.pos.z - e.pos.z;
  return dx * dx + dz * dz <= INTEREST_RADIUS_SQ;
}

export class WorldRealmDurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: WorldEnv;

  private sim: Sim | null = null;
  private db: WocDb | null = null;
  private interval: number | null = null;

  private readonly conns = new Map<WebSocket, Conn>();
  private readonly sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: WorldEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== '/ws') {
      return new Response('not found', { status: 404 });
    }

    const userId = req.headers.get('x-woc-user');
    const characterRaw = req.headers.get('x-woc-character');
    const realm = req.headers.get('x-woc-realm');
    const characterId = Number(characterRaw);
    if (!userId || !realm || !Number.isFinite(characterId)) {
      return new Response('missing identity headers', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // Lazily stand up the world on the first connection. Subsequent reconnects
    // (after the DO drained to zero and tore everything down) re-init here.
    if (!this.sim) {
      this.sim = new Sim({ seed: 20061, playerClass: 'warrior', noPlayer: true });
    }
    if (!this.db) {
      this.db = createWocDb(this.env.HYPERDRIVE.connectionString);
    }
    const sim = this.sim;
    const db = this.db;

    let character;
    try {
      character = await db.getCharacter(userId, characterId, realm);
    } catch (err) {
      console.error('failed to load character:', err);
      this.sendJson(server, { t: 'error', error: 'character load failed' });
      try { server.close(1011, 'load failed'); } catch { /* noop */ }
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!character) {
      this.sendJson(server, { t: 'error', error: 'no such character' });
      try { server.close(1008, 'no such character'); } catch { /* noop */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    const pid = sim.addPlayer(character.class as PlayerClass, character.name, {
      state: (character.state ?? undefined) as CharacterState | undefined,
    });

    const conn: Conn = {
      socket: server,
      pid,
      userId,
      characterId,
      realm,
      name: character.name,
      dbSessionId: null,
      lastSave: Date.now(),
    };
    this.conns.set(server, conn);
    this.sockets.add(server);

    // Open a play session for analytics; fire-and-forget so connect stays snappy.
    db.openPlaySession(userId, characterId, character.name)
      .then((id) => { conn.dbSessionId = id; })
      .catch((err) => console.error('failed to open play session:', err));

    this.sendJson(server, { t: 'hello', pid, seed: sim.cfg.seed, realm });

    server.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') this.handleMessage(conn, data);
    });
    server.addEventListener('close', () => { void this.handleClose(conn); });
    server.addEventListener('error', () => { void this.handleClose(conn); });

    this.startLoop();
    // Watchdog: keep the alarm armed while players are connected.
    void this.ctx.storage.setAlarm(Date.now() + 60_000);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Input & commands (M1 subset)
  // -------------------------------------------------------------------------

  private handleMessage(conn: Conn, raw: string): void {
    const sim = this.sim;
    if (!sim) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;

    try {
      const pid = conn.pid;
      if (msg.t === 'input') {
        const meta = sim.meta(pid);
        const e = sim.entities.get(pid);
        if (!meta || !e) return;
        const { moveInput, facing } = parseMoveInputFrame(msg);
        Object.assign(meta.moveInput, moveInput);
        if (facing !== null && !e.dead) e.facing = facing;
        return;
      }
      if (msg.t !== 'cmd') return;
      switch (msg.cmd) {
        case 'target': sim.targetEntity(typeof msg.id === 'number' ? msg.id : null, pid); break;
        case 'tab': sim.tabTarget(pid); break;
        case 'targetNearest': sim.targetNearestEnemy(pid); break;
        case 'attack': sim.startAutoAttack(pid); break;
        case 'stopattack': sim.stopAutoAttack(pid); break;
        case 'cast': if (typeof msg.ability === 'string') sim.castAbility(msg.ability, pid); break;
        case 'castSlot': sim.castAbilityBySlot(msg.slot | 0, pid); break;
        case 'interact': sim.interact(pid); break;
        case 'release': sim.releaseSpirit(pid); break;
        default: break; // chat/party/trade/duel/social/market/quest/loadout: M2
      }
    } catch (err) {
      console.error(`bad message from ${conn.name} (cmd: ${String(msg?.cmd ?? msg?.t)}):`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------------

  private startLoop(): void {
    if (this.interval) return;
    let last = Date.now();
    let acc = 0;
    let saveTimer = 0;
    this.interval = setInterval(() => {
      const sim = this.sim;
      if (!sim) return;
      const now = Date.now();
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.5) dt = 0.5;
      acc += dt;
      while (acc >= DT) {
        sim.tick();
        acc -= DT;
      }
      this.broadcastSnapshots();
      saveTimer += dt;
      if (saveTimer >= 30) {
        saveTimer = 0;
        void this.saveAll();
      }
    }, 50) as unknown as number;
  }

  // -------------------------------------------------------------------------
  // Snapshots (simplified: full records every tick, no delta/keep cache)
  // -------------------------------------------------------------------------

  private broadcastSnapshots(): void {
    const sim = this.sim;
    if (!sim || this.sockets.size === 0) return;
    const tick = sim.tickCount;
    const time = round2(sim.time);

    for (const conn of this.conns.values()) {
      const p = sim.entities.get(conn.pid);
      const meta = sim.meta(conn.pid);
      if (!p || !meta) continue;
      if (conn.socket.readyState !== WebSocket.OPEN) continue;

      const ents: Record<string, unknown>[] = [];
      for (const e of sim.entities.values()) {
        if (e.id === conn.pid) continue;
        if (!withinInterest(p, e)) continue;
        ents.push(wireEntity(e));
      }

      const self: Record<string, unknown> = {
        ...wireEntity(p),
        res: round2(p.resource),
        mres: p.maxResource,
        rtype: p.resourceType,
        target: p.targetId,
        auto: p.autoAttack,
        gcd: round2(p.gcdRemaining),
        combo: p.comboPoints,
        ap: p.attackPower,
        crit: p.critChance,
        dodge: p.dodgeChance,
        xp: meta.xp,
        copper: meta.copper,
        stats: p.stats,
        weapon: p.weapon,
        inv: meta.inventory,
        equip: meta.equipment,
      };

      this.sendJson(conn.socket, { t: 'snap', tick, time, self, ents });
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle & persistence
  // -------------------------------------------------------------------------

  private async handleClose(conn: Conn): Promise<void> {
    if (!this.conns.has(conn.socket)) return; // already handled
    this.conns.delete(conn.socket);
    this.sockets.delete(conn.socket);

    const sim = this.sim;
    const db = this.db;
    if (sim && db) {
      await this.saveCharacter(conn).catch((err) => console.error('save on leave failed:', err));
      sim.removePlayer(conn.pid);
      if (conn.dbSessionId !== null) {
        void db.closePlaySession(conn.dbSessionId).catch((err) => console.error('failed to close play session:', err));
      }
    }

    if (this.sockets.size === 0) {
      // Drain to nothing: persist everything, stop the loop, drop the pool, and
      // forget the sim so the next connection re-inits a fresh authoritative world.
      await this.saveAll();
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
      try { await this.db?.end(); } catch (err) { console.error('db close failed:', err); }
      this.db = null;
      this.sim = null;
      try { await this.ctx.storage.deleteAlarm(); } catch { /* noop */ }
    }
  }

  private async saveCharacter(conn: Conn): Promise<void> {
    const sim = this.sim;
    const db = this.db;
    if (!sim || !db) return;
    const state = sim.serializeCharacter(conn.pid);
    const e = sim.entities.get(conn.pid);
    if (state && e) {
      await db.saveCharacterState(conn.characterId, e.level, state);
      conn.lastSave = Date.now();
    }
  }

  private async saveAll(): Promise<void> {
    for (const conn of this.conns.values()) {
      try {
        await this.saveCharacter(conn);
      } catch (err) {
        console.error(`autosave failed for ${conn.name}:`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Watchdog. M1: simply keep the alarm armed while sockets are live. Full
  // eviction-revival (re-spinning a sim after the runtime evicts the DO with
  // sockets still nominally open) is out of scope — the 30 s autosave plus
  // save-on-close provide durability. See report CONCERNS.
  // -------------------------------------------------------------------------
  async alarm(): Promise<void> {
    if (this.sockets.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private sendJson(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      console.error('socket send failed:', err);
    }
  }
}
