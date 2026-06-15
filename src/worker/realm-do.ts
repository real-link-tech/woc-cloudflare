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
import type { Entity, PlayerClass, SimEvent } from '../sim/types';
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

  // Shared World Market realm state: loaded once per sim lifetime, persisted on
  // autosave + drain. `marketRealm` is captured on first connect so the save
  // path has a realm even if all conns have left.
  private marketLoaded = false;
  private marketRealm: string | null = null;

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

    // The World Market is shared realm state. Load it once per sim lifetime (the
    // listings array is empty on a fresh sim); tolerate a missing row.
    if (!this.marketLoaded) {
      this.marketLoaded = true;
      this.marketRealm = realm;
      try {
        sim.loadMarket(await db.loadWorldState(realm, 'market'));
      } catch (err) {
        console.error('failed to load world market:', err);
      }
    }

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
        case 'castSlot': sim.castAbilityBySlot(msg.slot | 0, pid); break;
        case 'cast': if (typeof msg.ability === 'string') sim.castAbility(msg.ability, pid); break;
        case 'target': sim.targetEntity(typeof msg.id === 'number' ? msg.id : null, pid); break;
        case 'tab': sim.tabTarget(pid); break;
        case 'targetNearest': sim.targetNearestEnemy(pid); break;
        case 'attack': sim.startAutoAttack(pid); break;
        case 'stopattack': sim.stopAutoAttack(pid); break;
        case 'interact': sim.interact(pid); break;
        case 'loot': if (typeof msg.id === 'number') sim.lootCorpse(msg.id, pid); break;
        case 'pickup': if (typeof msg.id === 'number') sim.pickUpObject(msg.id, pid); break;
        // Quests: the snapshot carries quest state every tick (see broadcastSnapshots),
        // so the Node server's resyncQuests(session) is unnecessary here.
        case 'accept': if (typeof msg.quest === 'string') sim.acceptQuest(msg.quest, pid); break;
        case 'turnin': if (typeof msg.quest === 'string') sim.turnInQuest(msg.quest, pid); break;
        case 'abandon': if (typeof msg.quest === 'string') sim.abandonQuest(msg.quest, pid); break;
        case 'equip': if (typeof msg.item === 'string') sim.equipItem(msg.item, pid); break;
        case 'use': if (typeof msg.item === 'string') sim.useItem(msg.item, pid); break;
        case 'discard':
          if (typeof msg.item === 'string') {
            sim.discardItem(msg.item, typeof msg.count === 'number' ? msg.count : undefined, pid);
          }
          break;
        case 'buy': if (typeof msg.npc === 'number' && typeof msg.item === 'string') sim.buyItem(msg.npc, msg.item, pid); break;
        case 'sell':
          if (typeof msg.item === 'string') {
            sim.sellItem(msg.item, typeof msg.count === 'number' ? msg.count : undefined, pid);
          }
          break;
        case 'buyback': if (typeof msg.item === 'string') sim.buyBackItem(msg.item, pid); break;
        case 'release': sim.releaseSpirit(pid); break;
        // Minimal chat: emit a world/say SimEvent via the sim; the resulting
        // chat events flow to clients through routeEvents. /who, guild/officer
        // (/g,/o), and whisper-/r routing need the DB-backed SocialService and
        // are deferred.
        case 'chat': if (typeof msg.text === 'string') sim.chat(msg.text, pid); break;
        // party
        case 'pinvite': if (typeof msg.id === 'number') sim.partyInvite(msg.id, pid); break;
        case 'paccept': sim.partyAccept(pid); break;
        case 'pdecline': sim.partyDecline(pid); break;
        case 'pleave': sim.partyLeave(pid); break;
        case 'pkick': if (typeof msg.id === 'number') sim.partyKick(msg.id, pid); break;
        // raid/target markers
        case 'setMarker': if (typeof msg.id === 'number' && typeof msg.marker === 'number') sim.setMarker(msg.id, msg.marker, pid); break;
        case 'clearMarker': if (typeof msg.id === 'number') sim.clearMarker(msg.id, pid); break;
        // trade
        case 'trade_req': if (typeof msg.id === 'number') sim.tradeRequest(msg.id, pid); break;
        case 'trade_accept': sim.tradeAccept(pid); break;
        case 'trade_offer':
          if (Array.isArray(msg.items)) sim.tradeSetOffer(msg.items, Number(msg.copper) || 0, pid);
          break;
        case 'trade_confirm': sim.tradeConfirm(pid); break;
        case 'trade_cancel': sim.tradeCancel(pid); break;
        // duels
        case 'duel_req': if (typeof msg.id === 'number') sim.duelRequest(msg.id, pid); break;
        case 'duel_accept': sim.duelAccept(pid); break;
        case 'duel_decline': sim.duelDecline(pid); break;
        // arena (Ashen Coliseum 1v1 queue)
        case 'arena_queue': sim.arenaQueueJoin(pid); break;
        case 'arena_leave': sim.arenaQueueLeave(pid); break;
        // post-cap cosmetic prestige (Max-Level XP Overflow, Phase 4)
        case 'prestige': sim.prestige(pid); break;
        // Talents & Specializations — every allocation re-validated in the Sim.
        case 'applyTalents': {
          const a = msg.alloc;
          if (a && typeof a === 'object') {
            sim.applyTalents({
              spec: typeof a.spec === 'string' ? a.spec : null,
              ranks: (a.ranks && typeof a.ranks === 'object') ? a.ranks : {},
              choices: (a.choices && typeof a.choices === 'object') ? a.choices : {},
            }, pid);
          }
          break;
        }
        case 'respec': sim.respec(pid); break;
        case 'setSpec': sim.setSpec(typeof msg.spec === 'string' ? msg.spec : null, pid); break;
        case 'saveLoadout': {
          const a = msg.alloc;
          const alloc = a && typeof a === 'object'
            ? {
              spec: typeof a.spec === 'string' ? a.spec : null,
              ranks: (a.ranks && typeof a.ranks === 'object') ? a.ranks : {},
              choices: (a.choices && typeof a.choices === 'object') ? a.choices : {},
            }
            : undefined;
          if (typeof msg.name === 'string') sim.saveLoadout(msg.name, Array.isArray(msg.bar) ? msg.bar : [], pid, alloc);
          break;
        }
        case 'switchLoadout': if (typeof msg.index === 'number') sim.switchLoadout(msg.index | 0, pid); break;
        case 'deleteLoadout': if (typeof msg.index === 'number') sim.deleteLoadout(msg.index | 0, pid); break;
        // World Market (the Merchant's auction house)
        case 'market_list':
          if (typeof msg.item === 'string' && Number.isFinite(msg.count) && Number.isFinite(msg.price)) {
            sim.marketList(msg.item, msg.count, msg.price, pid);
          }
          break;
        case 'market_buy': if (typeof msg.id === 'number') sim.marketBuy(msg.id, pid); break;
        case 'market_cancel': if (typeof msg.id === 'number') sim.marketCancel(msg.id, pid); break;
        case 'market_collect': sim.marketCollect(pid); break;
        // dungeons ('enter_crypt'/'leave_crypt' kept as aliases for older bots)
        case 'enter_crypt':
        case 'enter_dungeon': {
          // must actually be near that dungeon's door
          const dungeonId = msg.cmd === 'enter_crypt' ? 'hollow_crypt' : msg.dungeon;
          if (typeof dungeonId !== 'string') break;
          const e = sim.entities.get(pid);
          const door = [...sim.entities.values()].find((x) => x.templateId === 'dungeon_door' && x.dungeonId === dungeonId);
          if (e && door && Math.hypot(e.pos.x - door.pos.x, e.pos.z - door.pos.z) < 8) sim.enterDungeon(dungeonId, pid);
          break;
        }
        case 'leave_crypt':
        case 'leave_dungeon': {
          const e = sim.entities.get(pid);
          const exit = e ? [...sim.entities.values()].find((x) => x.templateId === 'dungeon_exit' && Math.hypot(e.pos.x - x.pos.x, e.pos.z - x.pos.z) < 8) : null;
          if (exit) sim.leaveDungeon(pid);
          break;
        }
        // Skipped (need DB-backed SocialService — not ported): friend_*, block_*,
        // guild_*, social_refresh. Skipped (dev/ops): dev_level/dev_teleport/dev_give.
        default: break;
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
      // Capture the SimEvents each tick produces (melee swings, casts, hits,
      // damage, loot, level-ups, …). Without forwarding these to clients the
      // world looks frozen in combat — no attack animation, no floating damage,
      // no spell VFX. Accumulate across all catch-up ticks, route once per frame.
      const frameEvents: SimEvent[] = [];
      while (acc >= DT) {
        frameEvents.push(...sim.tick());
        acc -= DT;
      }
      this.broadcastSnapshots();
      this.routeEvents(frameEvents);
      saveTimer += dt;
      if (saveTimer >= 30) {
        saveTimer = 0;
        void this.saveAll();
      }
    }, 50) as unknown as number;
  }

  // -------------------------------------------------------------------------
  // Events: drive client-side combat feedback (attack/cast animations, damage
  // numbers, VFX). World events (no pid) go to every connected player; events
  // scoped to one player (ev.pid set, e.g. "you gained XP") only to its owner.
  // Mirrors the original GameServer.routeEvents minus the interest-radius filter,
  // which is fine for the small M1 world.
  // -------------------------------------------------------------------------

  private routeEvents(events: SimEvent[]): void {
    if (events.length === 0) return;
    for (const conn of this.conns.values()) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      const mine = events.filter((ev) => ev.pid === undefined || ev.pid === conn.pid);
      if (mine.length > 0) {
        try { conn.socket.send(JSON.stringify({ t: 'events', list: mine })); } catch { /* socket closing */ }
      }
    }
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

      const pid = conn.pid;
      const self: Record<string, unknown> = {
        ...wireEntity(p),
        res: round2(p.resource),
        mres: p.maxResource,
        rtype: p.resourceType,
        target: p.targetId,
        auto: p.autoAttack,
        gcd: round2(p.gcdRemaining),
        combo: p.comboPoints,
        comboTgt: p.comboTargetId,
        queued: p.queuedOnSwing,
        ap: p.attackPower,
        crit: p.critChance,
        dodge: p.dodgeChance,
        eat: p.eating ? { remaining: round2(p.eating.remaining) } : null,
        drk: p.drinking ? { remaining: round2(p.drinking.remaining) } : null,
        opUntil: p.overpowerUntil > sim.time ? 1 : 0,
        xp: meta.xp,
        lxp: meta.lifetimeXp,
        prk: meta.prestigeRank,
        copper: meta.copper,
        stats: p.stats,
        weapon: p.weapon,
        cds: Object.fromEntries([...p.cooldowns.entries()].map(([k, v]) => [k, round2(v)])),
        inv: meta.inventory,
        equip: meta.equipment,
        buyback: meta.vendorBuyback,
        milestones: [...meta.unlockedMilestones],
        qlog: [...meta.questLog.values()],
        qdone: [...meta.questsDone],
        party: this.partyWire(pid),
        marks: this.markersWire(pid),
        trade: this.tradeWire(pid),
        duel: this.duelWire(pid),
        arena: sim.arenaInfoFor(pid),
        market: sim.marketInfoFor(pid),
        tal: {
          alloc: meta.talents,
          spec: meta.talentMods.spec,
          role: meta.talentMods.role,
          loadouts: meta.loadouts,
          activeLoadout: meta.activeLoadout,
        },
      };

      this.sendJson(conn.socket, { t: 'snap', tick, time, self, ents });
    }
  }

  // -------------------------------------------------------------------------
  // Wire helpers for the self snapshot (pure reads of the Sim). Ported from the
  // Node GameServer (server/game.ts:1066-1112).
  // -------------------------------------------------------------------------

  private partyWire(pid: number): unknown {
    const sim = this.sim;
    if (!sim) return null;
    const party = sim.partyOf(pid);
    if (!party) return null;
    return {
      leader: party.leader,
      members: party.members.map((mPid) => {
        const meta = sim.meta(mPid);
        const e = sim.entities.get(mPid);
        return meta && e ? {
          pid: mPid, name: meta.name, cls: meta.cls, level: e.level,
          hp: e.hp, mhp: e.maxHp, res: Math.round(e.resource), mres: e.maxResource, rtype: e.resourceType,
          x: round2(e.pos.x), z: round2(e.pos.z), dead: e.dead ? 1 : 0, inCombat: e.inCombat ? 1 : 0,
        } : null;
      }).filter(Boolean),
    };
  }

  // Raid markers the player's party can see, as { entityId: markerId }; null
  // when the player is in no party. Pure read — the sim owns marker cleanup.
  private markersWire(pid: number): unknown {
    const sim = this.sim;
    if (!sim) return null;
    const party = sim.partyOf(pid);
    if (!party) return null;
    return sim.markersFor(pid);
  }

  private tradeWire(pid: number): unknown {
    const sim = this.sim;
    if (!sim) return null;
    const t = sim.tradeFor(pid);
    if (!t) return null;
    const mine = t.a === pid;
    const otherPid = mine ? t.b : t.a;
    const other = sim.meta(otherPid);
    return {
      otherPid,
      otherName: other?.name ?? '?',
      myOffer: mine ? t.offerA : t.offerB,
      theirOffer: mine ? t.offerB : t.offerA,
      myAccepted: mine ? t.acceptedA : t.acceptedB,
      theirAccepted: mine ? t.acceptedB : t.acceptedA,
    };
  }

  private duelWire(pid: number): unknown {
    const sim = this.sim;
    if (!sim) return null;
    const d = sim.duelFor(pid);
    if (!d) return null;
    const otherPid = d.a === pid ? d.b : d.a;
    return { otherPid, otherName: sim.meta(otherPid)?.name ?? '?', state: d.state };
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
      this.marketLoaded = false;
      this.marketRealm = null;
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
    // Persist the shared World Market alongside character autosave.
    const sim = this.sim;
    const db = this.db;
    if (sim && db && this.marketRealm) {
      try {
        await db.saveWorldState(this.marketRealm, 'market', sim.serializeMarket());
      } catch (err) {
        console.error('world market save failed:', err);
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
