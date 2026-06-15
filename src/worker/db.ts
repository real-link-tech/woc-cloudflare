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

// Hyperdrive pools connections at the edge, so a fresh short-lived Client per
// operation is the recommended pattern (a long-lived Pool inside a Durable
// Object holds connections that go stale and hang). Connect, run, always close.
export async function withClient<T>(connectionString: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => { /* already closing */ });
  }
}

export function createWocDb(connectionString: string): WocDb {
  return {
    listCharacters(userId, realm) {
      return withClient(connectionString, async (c) => {
        const r = await c.query<CharacterRow>(
          'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE ipio_user_id=$1 AND realm=$2 ORDER BY id',
          [userId, realm],
        );
        return r.rows;
      });
    },
    getCharacter(userId, characterId, realm) {
      return withClient(connectionString, async (c) => {
        const r = await c.query<CharacterRow>(
          'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE id=$1 AND ipio_user_id=$2 AND realm=$3',
          [characterId, userId, realm],
        );
        return r.rows[0] ?? null;
      });
    },
    createCharacter(userId, name, cls, realm) {
      return withClient(connectionString, async (c) => {
        const r = await c.query<CharacterRow>(
          'INSERT INTO ipio_woc_characters (ipio_user_id, name, class, realm) VALUES ($1,$2,$3,$4) RETURNING id, ipio_user_id, name, class, level, state, is_gm',
          [userId, name, cls, realm],
        );
        return r.rows[0];
      });
    },
    saveCharacterState(characterId, level, state) {
      return withClient(connectionString, async (c) => {
        await c.query(
          'UPDATE ipio_woc_characters SET level=$2, state=$3, updated_at=now() WHERE id=$1',
          [characterId, level, JSON.stringify(state)],
        );
      });
    },
    openPlaySession(userId, characterId, name) {
      return withClient(connectionString, async (c) => {
        const r = await c.query<{ id: number }>(
          'INSERT INTO ipio_woc_play_sessions (ipio_user_id, character_id, character_name) VALUES ($1,$2,$3) RETURNING id',
          [userId, characterId, name],
        );
        return r.rows[0].id;
      });
    },
    closePlaySession(sessionId) {
      return withClient(connectionString, async (c) => {
        await c.query('UPDATE ipio_woc_play_sessions SET ended_at=now() WHERE id=$1 AND ended_at IS NULL', [sessionId]);
      });
    },
    loadWorldState<T>(realm: string, key: string): Promise<T | null> {
      return withClient(connectionString, async (c) => {
        const r = await c.query<{ data: T }>('SELECT data FROM ipio_woc_world_state WHERE realm=$1 AND key=$2', [realm, key]);
        return r.rows[0]?.data ?? null;
      });
    },
    saveWorldState(realm, key, data) {
      return withClient(connectionString, async (c) => {
        await c.query(
          'INSERT INTO ipio_woc_world_state (realm,key,data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (realm,key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()',
          [realm, key, JSON.stringify(data)],
        );
      });
    },
    // No pool to close; each operation opens and closes its own Client.
    async end() {},
  };
}
