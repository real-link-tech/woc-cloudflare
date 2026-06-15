import { Pool } from 'pg';
import type { CharacterState } from '../sim/sim';
import type { PlayerClass } from '../sim/types';

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

// One pool per worker/DO instance, reused across calls. Hyperdrive pools the
// underlying Neon connections, so a small client pool here is fine.
export function createWocDb(connectionString: string): WocDb {
  const pool = new Pool({ connectionString, max: 5 });
  return {
    async listCharacters(userId, realm) {
      const r = await pool.query<CharacterRow>(
        'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE ipio_user_id=$1 AND realm=$2 ORDER BY id',
        [userId, realm],
      );
      return r.rows;
    },
    async getCharacter(userId, characterId, realm) {
      const r = await pool.query<CharacterRow>(
        'SELECT id, ipio_user_id, name, class, level, state, is_gm FROM ipio_woc_characters WHERE id=$1 AND ipio_user_id=$2 AND realm=$3',
        [characterId, userId, realm],
      );
      return r.rows[0] ?? null;
    },
    async createCharacter(userId, name, cls, realm) {
      const r = await pool.query<CharacterRow>(
        'INSERT INTO ipio_woc_characters (ipio_user_id, name, class, realm) VALUES ($1,$2,$3,$4) RETURNING id, ipio_user_id, name, class, level, state, is_gm',
        [userId, name, cls, realm],
      );
      return r.rows[0];
    },
    async saveCharacterState(characterId, level, state) {
      await pool.query(
        'UPDATE ipio_woc_characters SET level=$2, state=$3, updated_at=now() WHERE id=$1',
        [characterId, level, JSON.stringify(state)],
      );
    },
    async openPlaySession(userId, characterId, name) {
      const r = await pool.query<{ id: number }>(
        'INSERT INTO ipio_woc_play_sessions (ipio_user_id, character_id, character_name) VALUES ($1,$2,$3) RETURNING id',
        [userId, characterId, name],
      );
      return r.rows[0].id;
    },
    async closePlaySession(sessionId) {
      await pool.query('UPDATE ipio_woc_play_sessions SET ended_at=now() WHERE id=$1 AND ended_at IS NULL', [sessionId]);
    },
    async loadWorldState<T>(realm: string, key: string): Promise<T | null> {
      const r = await pool.query<{ data: T }>('SELECT data FROM ipio_woc_world_state WHERE realm=$1 AND key=$2', [realm, key]);
      return r.rows[0]?.data ?? null;
    },
    async saveWorldState(realm, key, data) {
      await pool.query(
        'INSERT INTO ipio_woc_world_state (realm,key,data,updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (realm,key) DO UPDATE SET data=EXCLUDED.data, updated_at=now()',
        [realm, key, JSON.stringify(data)],
      );
    },
    async end() {
      await pool.end();
    },
  };
}
