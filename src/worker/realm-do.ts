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
import { zoneAt, DUNGEONS } from '../sim/data';
import { setDynamicColliders, worldObjectCollider } from '../sim/colliders';
import { createWocDb, HyperdriveConn, type WocDb } from './db';
import { PgSocialDb } from './social-db';
import { SocialService, type SocialActor, type SocialEvent, type SocialTransport, type Presence, type PresenceStatus } from './social';
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
  // Set of character ids this player has ignored, loaded on join. Drives the
  // chat-ignore filter (say chat in routeEvents + guild/officer in the service).
  blockedIds: Set<number>;
  // Friends + guildmates to push live positions to (the cheap socialpos tick).
  socialTrackedIds?: number[];
}

// Squared interest radius: a player only receives entities within 100 units.
const INTEREST_RADIUS = 100;
const INTEREST_RADIUS_SQ = INTEREST_RADIUS * INTEREST_RADIUS;

function withinInterest(p: Entity, e: Entity): boolean {
  const dx = p.pos.x - e.pos.x;
  const dz = p.pos.z - e.pos.z;
  return dx * dx + dz * dz <= INTEREST_RADIUS_SQ;
}

// A player-placed IPIO library asset — the "build the world" feature. Persisted
// per realm in ipio_woc_world_state under the 'world_objects' key (same mechanism
// as the World Market), broadcast to all clients, and reloaded on DO restart.
export interface WorldObject {
  id: string;
  ipAssetId: string;  // source IPIO asset id (reference/attribution)
  glbUrl: string;     // the GLB to render (IPIO CDN / signed asset URL)
  name: string;
  x: number; y: number; z: number;
  rot: number;        // yaw, radians
  scale: number;
  footprint?: number; // unscaled XZ collider radius from the client's measured model bounds
  placedBy: string;   // placer's character name
}

const MAX_WORLD_OBJECTS = 500;
// Only allow GLB URLs from IPIO's own asset hosts — a placed object's URL is
// loaded by every client, so it must not be an arbitrary attacker-controlled URL.
const ALLOWED_GLB_HOSTS = new Set(['assets.ipio.ai', 'api.ipio.ai', 'api-dev.ipio.ai']);
function validGlbUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 1024) return false;
  try { const url = new URL(u); return url.protocol === 'https:' && ALLOWED_GLB_HOSTS.has(url.hostname); } catch { return false; }
}

export class WorldRealmDurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: WorldEnv;

  private sim: Sim | null = null;
  private db: WocDb | null = null;
  private interval: number | null = null;

  // One warm, self-healing Hyperdrive connection shared by WocDb + the social DB
  // for fast repeated single queries (a fresh connect per query made social.snapshot
  // slow). Transactions still open their own short-lived Client. Closed on drain.
  private dbConn: HyperdriveConn | null = null;

  // Social system (friends/ignore/guilds/presence). PgSocialDb runs single queries
  // on the shared warm connection and transactions on a fresh per-op Client.
  // SocialService is the pure engine wired to that DB + a transport bridging to
  // live DO state.
  private socialDb: PgSocialDb | null = null;
  private social: SocialService | null = null;

  private readonly conns = new Map<WebSocket, Conn>();
  private readonly sockets = new Set<WebSocket>();
  // Reverse index: character id → live connection, for the social transport.
  private readonly connsByCharId = new Map<number, Conn>();

  // Shared World Market realm state: loaded once per sim lifetime, persisted on
  // autosave + drain. `marketRealm` is captured on first connect so the save
  // path has a realm even if all conns have left.
  private marketLoaded = false;
  private marketRealm: string | null = null;

  // Player-placed world objects (the build feature). Loaded once per sim lifetime
  // from ipio_woc_world_state, kept in memory, persisted on change, broadcast to
  // all clients, and re-sent in full to each newly-connected player.
  private readonly worldObjects = new Map<string, WorldObject>();
  private worldObjectsLoaded = false;
  private worldObjectsRealm: string | null = null;

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
    if (!this.dbConn) {
      this.dbConn = new HyperdriveConn(this.env.HYPERDRIVE.connectionString);
    }
    if (!this.db) {
      this.db = createWocDb(this.dbConn);
    }
    if (!this.social) {
      this.socialDb = new PgSocialDb(this.dbConn, realm);
      this.social = new SocialService(this.socialDb, this.buildSocialTransport());
    }
    const sim = this.sim;
    const db = this.db;
    const social = this.social;
    const socialDb = this.socialDb!;

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

    // Player-placed world objects: load the realm's build once per sim lifetime,
    // same world_state mechanism as the market.
    if (!this.worldObjectsLoaded) {
      this.worldObjectsLoaded = true;
      this.worldObjectsRealm = realm;
      try {
        const stored = await db.loadWorldState<WorldObject[]>(realm, 'world_objects');
        if (Array.isArray(stored)) for (const o of stored) this.worldObjects.set(o.id, o);
      } catch (err) {
        console.error('failed to load world objects:', err);
      }
      this.syncWorldObjectColliders();
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
      blockedIds: new Set(),
    };
    this.conns.set(server, conn);
    this.sockets.add(server);
    this.connsByCharId.set(characterId, conn);

    // Open a play session for analytics; fire-and-forget so connect stays snappy.
    db.openPlaySession(userId, characterId, character.name)
      .then((id) => { conn.dbSessionId = id; })
      .catch((err) => console.error('failed to open play session:', err));

    this.sendJson(server, { t: 'hello', pid, seed: sim.cfg.seed, realm });
    // Send the realm's existing build so the new player sees what others placed.
    if (this.worldObjects.size > 0) {
      this.sendJson(server, { t: 'world_objects', list: [...this.worldObjects.values()] });
    }

    server.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') this.handleMessage(conn, data);
    });
    server.addEventListener('close', () => { void this.handleClose(conn); });
    server.addEventListener('error', () => { void this.handleClose(conn); });

    this.startLoop();
    // Watchdog: keep the alarm armed while players are connected.
    void this.ctx.storage.setAlarm(Date.now() + 60_000);

    // Social init (mirrors GameServer.initSocial) runs FIRE-AND-FORGET so the WS
    // upgrade returns immediately. Blocking the 101 on these queries (ignore list
    // + the 4-query social snapshot + presence announce) left the client socket
    // CONNECTING for the whole DB round-trip. The socket is already accepted, so
    // the snapshot/events sent here are buffered and delivered once it opens.
    void (async () => {
      try {
        conn.blockedIds = new Set(await socialDb.blockedIds(characterId));
      } catch (err) {
        console.error('failed to load block list:', err);
      }
      await this.sendSocialSnapshot(characterId).catch((err) => console.error('social snapshot failed:', err));
      await social.announcePresence({ characterId, name: conn.name }, true)
        .catch((err) => console.error('presence announce failed:', err));
    })();

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
        // Chat: /who lists online players; /g,/gu,/guild route to guild chat and
        // /o,/officer to officer chat (both DB-backed via SocialService); anything
        // else (say / /w whisper / emote) goes to the sim, whose chat SimEvents
        // flow to clients through routeEvents. NOTE: the Node server's /r reply
        // and per-session chat rate-limiting are not ported here (see report).
        case 'chat': {
          if (typeof msg.text !== 'string') break;
          const text = String(msg.text).trim();
          if (!text) break;
          if (/^\/who(\s|$)/i.test(text)) {
            this.sendWhoRoster(conn);
            break;
          }
          const gm = /^\/(?:g|gu|guild)\s+([\s\S]+)$/i.exec(text);
          const om = gm ? null : /^\/(?:o|officer)\s+([\s\S]+)$/i.exec(text);
          if (gm || om) {
            const body = (gm ?? om!)[1];
            const actor: SocialActor = { characterId: conn.characterId, name: conn.name };
            const route = gm ? this.social?.guildChat(actor, body) : this.social?.officerChat(actor, body);
            void route?.catch((err) => console.error('guild/officer chat failed:', err));
            break;
          }
          sim.chat(text, pid);
          break;
        }
        // social: friends / ignore (persistent, character-scoped via SocialService)
        case 'friend_add': if (typeof msg.name === 'string') void this.social?.friendAdd(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'friend_remove': if (typeof msg.name === 'string') void this.social?.friendRemove(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'block_add': if (typeof msg.name === 'string') void this.social?.blockAdd(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'block_remove': if (typeof msg.name === 'string') void this.social?.blockRemove(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'social_refresh': void this.sendSocialSnapshot(conn.characterId); break;
        // Build the world: place / remove an IPIO library asset.
        case 'place_object': this.placeObject(conn, msg); break;
        case 'remove_object': if (typeof msg.id === 'string') this.removeObject(msg.id); break;
        // guilds
        case 'guild_create': if (typeof msg.name === 'string') void this.social?.guildCreate(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'guild_invite': if (typeof msg.name === 'string') void this.social?.guildInvite(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'guild_accept': void this.social?.guildAccept(this.actorFor(conn)).catch(console.error); break;
        case 'guild_decline': this.social?.guildDecline(this.actorFor(conn)); break;
        case 'guild_leave': void this.social?.guildLeave(this.actorFor(conn)).catch(console.error); break;
        case 'guild_kick': if (typeof msg.name === 'string') void this.social?.guildKick(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'guild_promote': if (typeof msg.name === 'string') void this.social?.guildSetRank(this.actorFor(conn), msg.name, 'officer').catch(console.error); break;
        case 'guild_demote': if (typeof msg.name === 'string') void this.social?.guildSetRank(this.actorFor(conn), msg.name, 'member').catch(console.error); break;
        case 'guild_transfer': if (typeof msg.name === 'string') void this.social?.guildTransferLeader(this.actorFor(conn), msg.name).catch(console.error); break;
        case 'guild_disband': void this.social?.guildDisband(this.actorFor(conn)).catch(console.error); break;
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
        // Skipped (dev/ops): dev_level/dev_teleport/dev_give.
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
    let socialPosTimer = 0;
    this.interval = setInterval(() => {
      // Last-resort net: one bad tick (a sim edge case, a broadcast error) must
      // never throw out of the timer and take the whole realm down with every
      // connected player. Log and keep ticking — a live world that drops one
      // frame beats a crashed realm. Mirrors the original server's
      // uncaughtException safety net.
      try {
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
        // Cheap (no-DB) ~1 Hz push of friends'/guildmates' live positions.
        socialPosTimer += dt;
        if (socialPosTimer >= 1) {
          socialPosTimer = 0;
          this.broadcastSocialPositions();
        }
        saveTimer += dt;
        if (saveTimer >= 30) {
          saveTimer = 0;
          void this.saveAll();
        }
      } catch (err) {
        console.error('tick loop error (kept alive):', err);
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
      const mine = events.filter((ev) => {
        // ignore list: drop say-chat originating from a character this player
        // has blocked, before it reaches their client (guild/officer chat is
        // filtered in the service via isIgnoring). Mirrors GameServer.isBlockedSender.
        if (ev.type === 'chat' && conn.blockedIds.size > 0 && this.isBlockedSender(conn, ev.fromPid)) return false;
        return ev.pid === undefined || ev.pid === conn.pid;
      });
      if (mine.length > 0) {
        try { conn.socket.send(JSON.stringify({ t: 'events', list: mine })); } catch { /* socket closing */ }
      }
    }
  }

  // True if the chat event's source pid belongs to a character the recipient has
  // ignored. Self-echoes (fromPid === own pid) are never blocked.
  private isBlockedSender(recipient: Conn, fromPid: number): boolean {
    if (fromPid === recipient.pid) return false;
    for (const c of this.conns.values()) {
      if (c.pid === fromPid) return recipient.blockedIds.has(c.characterId);
    }
    return false;
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
    // Drop from social state first so friends see them as offline in the notice.
    this.connsByCharId.delete(conn.characterId);
    this.social?.forget(conn.characterId);
    void this.social?.announcePresence({ characterId: conn.characterId, name: conn.name }, false)
      .catch((err) => console.error('presence announce failed:', err));

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
      // Drain to nothing: persist everything, stop the loop, close the warm DB
      // connection, and forget the sim so the next connection re-inits a fresh
      // authoritative world.
      await this.saveAll();
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
      try { await this.dbConn?.end(); } catch (err) { console.error('db close failed:', err); }
      this.dbConn = null;
      this.db = null;
      if (this.sim) setDynamicColliders(this.sim.cfg.seed, []);
      this.sim = null;
      this.socialDb = null;
      this.social = null;
      this.marketLoaded = false;
      this.marketRealm = null;
      this.worldObjects.clear();
      this.worldObjectsLoaded = false;
      this.worldObjectsRealm = null;
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
    // Flush the player-built world too. Placements persist eagerly on each
    // place/remove, but those writes are fire-and-forget — awaiting one here on
    // teardown/autosave closes the window where a just-placed object could be
    // lost if the DO is evicted before its async write lands.
    await this.saveWorldObjects();
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

  // -------------------------------------------------------------------------
  // Social system: transport bridge, presence, snapshots, /who. Ported from the
  // Node GameServer's social wiring (server/game.ts).
  // -------------------------------------------------------------------------

  private actorFor(conn: Conn): SocialActor {
    return { characterId: conn.characterId, name: conn.name };
  }

  // Case-insensitive unambiguous name lookup over live connections (mirrors
  // GameServer.sessionByName): exact case wins; otherwise a single ci match.
  private connByName(name: string): Conn | null {
    const wanted = name;
    const lower = name.toLowerCase();
    let ci: Conn | null = null;
    let ciCount = 0;
    for (const c of this.connsByCharId.values()) {
      if (c.name === wanted) return c;
      if (c.name.toLowerCase() === lower) { ci = c; ciCount++; }
    }
    return ciCount === 1 ? ci : null;
  }

  // Live location + activity of an online character, for friend/guild rosters.
  // Mirrors GameServer.presenceOf.
  private presenceOf(conn: Conn): Presence {
    const e = this.sim?.entities.get(conn.pid);
    if (!e) return { zone: 'Unknown', status: 'online' };
    let status: PresenceStatus = 'online';
    if (e.dead) status = 'dead';
    else if (e.dungeonId) status = 'dungeon';
    else if (e.inCombat) status = 'combat';
    const zone = e.dungeonId ? (DUNGEONS[e.dungeonId]?.name ?? e.dungeonId) : zoneAt(e.pos.z).name;
    return { zone, status, x: round2(e.pos.x), z: round2(e.pos.z) };
  }

  private buildSocialTransport(): SocialTransport {
    return {
      byCharacterId: (id) => {
        const c = this.connsByCharId.get(id);
        return c ? { characterId: c.characterId, name: c.name } : null;
      },
      byName: (name) => {
        const c = this.connByName(name);
        return c ? { characterId: c.characterId, name: c.name } : null;
      },
      isOnline: (id) => this.connsByCharId.has(id),
      locationOf: (id) => {
        const c = this.connsByCharId.get(id);
        return c ? this.presenceOf(c) : null;
      },
      deliver: (charId, events) => {
        const c = this.connsByCharId.get(charId);
        if (c && c.socket.readyState === WebSocket.OPEN) {
          try { c.socket.send(JSON.stringify({ t: 'events', list: events })); } catch { /* socket closing */ }
        }
      },
      pushSnapshot: (charId) => { void this.sendSocialSnapshot(charId); },
      onBlocksChanged: (charId, ids) => {
        const c = this.connsByCharId.get(charId);
        if (c) c.blockedIds = new Set(ids);
      },
      isIgnoring: (recipientId, senderCharacterId) => {
        return this.connsByCharId.get(recipientId)?.blockedIds.has(senderCharacterId) ?? false;
      },
    };
  }

  private async sendSocialSnapshot(charId: number): Promise<void> {
    const conn = this.connsByCharId.get(charId);
    const social = this.social;
    if (!conn || !social) return;
    try {
      const snap = await social.snapshot(charId);
      if (conn.socket.readyState === WebSocket.OPEN) {
        this.sendJson(conn.socket, { t: 'social', ...snap });
      }
      // remember who to track for the live position push (friends + guildmates)
      conn.socialTrackedIds = [
        ...snap.friends.map((f) => f.id),
        ...(snap.guild ? snap.guild.members.map((m) => m.id) : []),
      ];
    } catch (err) {
      console.error('social snapshot failed:', err);
    }
  }

  // Cheap (no-DB) periodic push: refresh the live positions of each client's
  // already-known friends/guildmates. Mirrors GameServer.broadcastSocialPositions.
  private broadcastSocialPositions(): void {
    for (const conn of this.conns.values()) {
      const ids = conn.socialTrackedIds;
      if (!ids || ids.length === 0) continue;
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      const list: { id: number; x: number; z: number; zone: string; status: PresenceStatus }[] = [];
      for (const id of ids) {
        const other = this.connsByCharId.get(id);
        if (!other) continue; // offline — snapshots own the online/offline flip
        const loc = this.presenceOf(other);
        if (loc.x === undefined || loc.z === undefined) continue;
        list.push({ id, x: loc.x, z: loc.z, zone: loc.zone, status: loc.status });
      }
      if (list.length > 0) this.sendJson(conn.socket, { t: 'socialpos', list });
    }
  }

  // /who: a roster of online players, delivered as social log events. Simplified
  // from GameServer.sendWhoRoster (no per-viewer ignore-gating beyond the basics).
  private sendWhoRoster(conn: Conn): void {
    const sim = this.sim;
    if (!sim) return;
    const rows: { name: string; level: number; cls: string; zone: string; status: PresenceStatus }[] = [];
    for (const c of this.connsByCharId.values()) {
      // hide players this viewer ignores, and players who ignore the viewer
      if (conn.blockedIds.has(c.characterId)) continue;
      if (c.characterId !== conn.characterId && c.blockedIds.has(conn.characterId)) continue;
      const e = sim.entities.get(c.pid);
      const meta = sim.meta(c.pid);
      if (!e || !meta) continue;
      const loc = this.presenceOf(c);
      rows.push({ name: c.name, level: e.level, cls: meta.cls, zone: loc.zone, status: loc.status });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const total = rows.length;
    const list: SocialEvent[] = [{
      type: 'log',
      text: `Who: ${total} ${total === 1 ? 'player' : 'players'} online on ${conn.realm}.`,
      color: '#7fd4ff',
    }];
    const limit = 50;
    for (const row of rows.slice(0, limit)) {
      const status = row.status === 'online' ? '' : ` (${row.status})`;
      list.push({ type: 'log', text: `${row.name} - level ${row.level} ${row.cls} - ${row.zone}${status}`, color: '#c9b27a' });
    }
    if (total > limit) {
      list.push({ type: 'log', text: `...and ${total - limit} more.`, color: '#998d6a' });
    }
    if (conn.socket.readyState === WebSocket.OPEN) {
      this.sendJson(conn.socket, { t: 'events', list });
    }
  }

  private sendJson(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      console.error('socket send failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Build the world: place / remove / persist / broadcast world objects
  // -------------------------------------------------------------------------

  private placeObject(conn: Conn, msg: any): void {
    if (!validGlbUrl(msg.glbUrl)) { this.sendErr(conn, 'That asset can’t be placed here.'); return; }
    if (this.worldObjects.size >= MAX_WORLD_OBJECTS) { this.sendErr(conn, 'This realm’s build limit is full.'); return; }
    const x = Number(msg.x), y = Number(msg.y ?? 0), z = Number(msg.z);
    const rot = Number(msg.rot ?? 0), scale = Number(msg.scale ?? 1);
    if (![x, y, z, rot, scale].every(Number.isFinite)) return;
    if (Math.abs(x) > 2000 || Math.abs(z) > 2000 || Math.abs(y) > 500 || scale <= 0 || scale > 20) return;
    // Optional client-measured unscaled footprint radius (collision matches the
    // model's real size). Bounded; absent/garbage falls back to a base radius.
    const footprintR = Number(msg.footprintR);
    const footprint = Number.isFinite(footprintR) && footprintR > 0 && footprintR <= 50 ? footprintR : undefined;
    const id = `wo_${conn.characterId}_${Date.now().toString(36)}_${this.worldObjects.size}`;
    const obj: WorldObject = {
      id,
      ipAssetId: String(msg.ipAssetId ?? '').slice(0, 128),
      glbUrl: msg.glbUrl,
      name: String(msg.name ?? '').slice(0, 64),
      x, y, z, rot, scale, footprint,
      placedBy: conn.name,
    };
    this.worldObjects.set(id, obj);
    this.syncWorldObjectColliders();
    this.broadcastJson({ t: 'world_object', op: 'add', obj });
    void this.saveWorldObjects();
  }

  private removeObject(id: string): void {
    if (this.worldObjects.delete(id)) {
      this.syncWorldObjectColliders();
      this.broadcastJson({ t: 'world_object', op: 'remove', id });
      void this.saveWorldObjects();
    }
  }

  // Feed the current player-placed build into the sim's collision system so the
  // authoritative movement/pathfinding resolves against it. Server-side only —
  // clients keep rendering from the same WorldObject set and receive snapshots.
  private syncWorldObjectColliders(): void {
    if (!this.sim) return;
    setDynamicColliders(
      this.sim.cfg.seed,
      [...this.worldObjects.values()].map(worldObjectCollider),
    );
  }

  private async saveWorldObjects(): Promise<void> {
    if (!this.db || !this.worldObjectsRealm) return;
    try {
      await this.db.saveWorldState(this.worldObjectsRealm, 'world_objects', [...this.worldObjects.values()]);
    } catch (err) {
      console.error('save world objects failed:', err);
    }
  }

  // Broadcast one JSON message to every connected player.
  private broadcastJson(payload: unknown): void {
    const s = JSON.stringify(payload);
    for (const conn of this.conns.values()) {
      if (conn.socket.readyState === WebSocket.OPEN) {
        try { conn.socket.send(s); } catch { /* socket closing */ }
      }
    }
  }

  private sendErr(conn: Conn, text: string): void {
    this.sendJson(conn.socket, { t: 'events', list: [{ type: 'error', text }] });
  }
}
