import { Client, types } from 'pg';
import type { CharacterState } from '../sim/sim';
import type { PlayerClass } from '../sim/types';

// Postgres returns int8 (BIGINT / BIGSERIAL) as STRINGS by default to avoid JS
// precision loss. Our ids (ipio_woc_characters.id, guild ids, …) are BIGSERIAL
// but always far within Number.MAX_SAFE_INTEGER, and the rest of the code (play
// tokens, connsByCharId map keys, social id comparisons) treats character ids as
// numbers. Without this, `target.id === actor.characterId` ("55" === 55) and
// `connsByCharId.get("55")` silently fail — which broke guild invites/chat.
// Parse int8 as a JS number globally (the pg type registry is process-wide).
types.setTypeParser(20, (v: string) => parseInt(v, 10));

export interface CharacterRow {
  id: number;
  ipio_user_id: string;
  name: string;
  class: PlayerClass;
  level: number;
  state: CharacterState | null;
  is_gm: boolean;
}

export interface WocDb {
  listCharacters(userId: string, realm: string): Promise<CharacterRow[]>;
  getCharacter(userId: string, characterId: number, realm: string): Promise<CharacterRow | null>;
  createCharacter(userId: string, name: string, cls: PlayerClass, realm: string): Promise<CharacterRow>;
  saveCharacterState(characterId: number, level: number, state: CharacterState): Promise<void>;
  openPlaySession(userId: string, characterId: number, name: string): Promise<number>;
  closePlaySession(sessionId: number): Promise<void>;
  loadWorldState<T>(realm: string, key: string): Promise<T | null>;
  saveWorldState(realm: string, key: string, data: unknown): Promise<void>;
  end(): Promise<void>;
}

// A fresh short-lived Client per call — used for TRANSACTIONS (BEGIN/COMMIT must
// own a connection exclusively, with no other query interleaving on it). Connect,
// run, always close. Hyperdrive makes connect fast.
export async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* already closing */ });
  }
}

// A single WARM, self-healing Client for repeated single (autocommit) queries
// inside a long-lived Durable Object. Opening a fresh Client per query (withClient)
// is correct but pays a connect round-trip every time, which made multi-query ops
// like social.snapshot (4 queries) take 1-2s. A reused connection is fast.
//
// The reason we ditched pg.Pool was that it handed out DEAD connections that hung
// FOREVER. We avoid that here with: (a) `query_timeout`/`statement_timeout`, so a
// query on a stale/dead socket FAILS fast instead of hanging; and (b) reset() on
// any error + a connection-level 'error' listener, so the next call reconnects.
// In an active realm the connection stays warm (autosave + social ops use it),
// so staleness is rare and self-heals when it happens.
//
// Concurrent .query() calls are safe: node-postgres queues queries on one Client.
// Transactions must NOT use this (they need exclusivity) — they use withClient.
export class HyperdriveConn {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  constructor(readonly connectionString: string) {}

  private async get(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const c = new Client({
        connectionString: this.connectionString,
        query_timeout: 10_000,
        statement_timeout: 10_000,
        connectionTimeoutMillis: 10_000,
      });
      // A connection-level error (socket dropped by Neon/Hyperdrive) invalidates
      // the client so the next query reconnects instead of using a dead socket.
      c.on('error', () => { if (this.client === c) this.client = null; });
      await c.connect();
      this.client = c;
      this.connecting = null;
      return c;
    })().catch((err) => { this.connecting = null; throw err; });
    return this.connecting;
  }

  async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> {
    try {
      const c = await this.get();
      const res = await c.query(sql, params);
      return { rows: res.rows as R[], rowCount: res.rowCount };
    } catch (err) {
      // The connection may be dead/timed-out — drop it so the next call reconnects.
      this.reset();
      throw err;
    }
  }

  private reset(): void {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    void c?.end().catch(() => { /* already closing */ });
  }

  async end(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.connecting = null;
    await c?.end().catch(() => { /* already closing */ });
  }
}

// Build a WocDb over a warm HyperdriveConn (single queries reuse one connection).
export function createWocDb(conn: HyperdriveConn): WocDb {
  return {
    async listCharacters(userId, realm) {
      const r = await conn.query<CharacterRow>(
        'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE ipio_user_id=$1 AND realm=$2 ORDER BY id',
        [userId, realm],
      );
      return r.rows;
    },
    async getCharacter(userId, characterId, realm) {
      const r = await conn.query<CharacterRow>(
        'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE id=$1 AND ipio_user_id=$2 AND realm=$3',
        [characterId, userId, realm],
      );
      return r.rows[0] ?? null;
    },
    async createCharacter(userId, name, cls, realm) {
      const r = await conn.query<CharacterRow>(
        'INSERT INTO ipio_woc_characters (ipio_user_id, name, class, realm) VALUES ($1,$2,$3,$4) RETURNING id, ipio_user_id, name, class, level, state, is_gm',
        [userId, name, cls, realm],
      );
      return r.rows[0];
    },
    async saveCharacterState(characterId, level, state) {
      await conn.query(
        'UPDATE ipio_woc_characters SET level=$2, state=$3, updated_at=now() WHERE id=$1',
        [characterId, level, JSON.stringify(state)],
      );
    },
    async openPlaySession(userId, characterId, name) {
      const r = await conn.query<{ id: number }>(
        'INSERT INTO ipio_woc_play_sessions (ipio_user_id, character_id, character_name) VALUES ($1,$2,$3) RETURNING id',
        [userId, characterId, name],
      );
      return r.rows[0].id;
    },
    async closePlaySession(sessionId) {
      await conn.query('UPDATE ipio_woc_play_sessions SET ended_at=now() WHERE id=$1 AND ended_at IS NULL', [sessionId]);
    },
    async loadWorldState<T>(realm: string, key: string): Promise<T | null> {
      const r = await conn.query<{ data: T }>('SELECT data FROM ipio_woc_world_state WHERE realm=$1 AND key=$2', [realm, key]);
      return r.rows[0]?.data ?? null;
    },
    async saveWorldState(realm, key, data) {
      await conn.query(
        'INSERT INTO ipio_woc_world_state (realm,key,data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (realm,key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()',
        [realm, key, JSON.stringify(data)],
      );
    },
    // The shared HyperdriveConn is owned + closed by the caller (the DO), so this
    // is a no-op — the WocDb doesn't own the connection.
    async end() {},
  };
}
