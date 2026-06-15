// Postgres-backed SocialDb for the Cloudflare DO. Ported from server/social_db.ts.
// All relationships are keyed by character id; the `realm` column scopes a
// character to a world/shard. The table names are prefixed `ipio_woc_` to match
// the dev Neon schema (see migrations/0002_woc_social.sql), and the realm is
// passed in by the DO rather than read from a process env constant.
//
// Single (autocommit) queries reuse the DO's warm HyperdriveConn (fast); the two
// transactions use a fresh per-op Client (withClient) since BEGIN/COMMIT need a
// connection to themselves.

import { types } from 'pg';
import { withClient, type HyperdriveConn } from './db';
import type { CharInfo, CharRef, GuildRank, SocialDb } from './social';

// Parse int8 (BIGINT/BIGSERIAL) as a JS number here too (also set in db.ts) so
// character/guild ids returned by these queries match the numeric keys used by
// the DO's connsByCharId map + id comparisons. Without it, `isOnline("71")` vs
// the numeric key 71 silently fails and guild broadcasts/snapshots never deliver.
types.setTypeParser(20, (v: string) => parseInt(v, 10));

const CHAR_COLS = 'id, name, class AS cls, level, realm';

export class PgSocialDb implements SocialDb {
  constructor(private readonly conn: HyperdriveConn, private readonly realm: string) {}

  async findCharacterByName(name: string): Promise<CharInfo | null> {
    // scoped to this realm: you can only friend/ignore/invite characters that
    // live on the same world as you. exact case wins; otherwise an unambiguous
    // case-insensitive match
    const exact = await this.conn.query<CharInfo>(`SELECT ${CHAR_COLS} FROM ipio_woc_characters WHERE name = $1 AND realm = $2`, [name, this.realm]);
    if (exact.rows[0]) return exact.rows[0];
    const ci = await this.conn.query<CharInfo>(`SELECT ${CHAR_COLS} FROM ipio_woc_characters WHERE lower(name) = lower($1) AND realm = $2 LIMIT 2`, [name, this.realm]);
    return ci.rows.length === 1 ? ci.rows[0] : null;
  }

  async getCharacter(id: number): Promise<CharInfo | null> {
    const res = await this.conn.query<CharInfo>(`SELECT ${CHAR_COLS} FROM ipio_woc_characters WHERE id = $1 AND realm = $2`, [id, this.realm]);
    return res.rows[0] ?? null;
  }

  async addFriend(charId: number, friendId: number): Promise<void> {
    await this.conn.query('INSERT INTO ipio_woc_friendships (character_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [charId, friendId]);
  }

  async removeFriend(charId: number, friendId: number): Promise<void> {
    await this.conn.query('DELETE FROM ipio_woc_friendships WHERE character_id = $1 AND friend_id = $2', [charId, friendId]);
  }

  async listFriends(charId: number): Promise<CharInfo[]> {
    const res = await this.conn.query<CharInfo>(
      `SELECT c.id, c.name, c.class AS cls, c.level, c.realm
       FROM ipio_woc_friendships f JOIN ipio_woc_characters c ON c.id = f.friend_id
       WHERE f.character_id = $1 ORDER BY c.name`,
      [charId],
    );
    return res.rows;
  }

  async whoFriended(charId: number): Promise<number[]> {
    const res = await this.conn.query<{ character_id: number }>('SELECT character_id FROM ipio_woc_friendships WHERE friend_id = $1', [charId]);
    return res.rows.map((r) => r.character_id);
  }

  async addBlock(charId: number, blockedId: number): Promise<void> {
    await this.conn.query('INSERT INTO ipio_woc_blocks (character_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [charId, blockedId]);
  }

  async removeBlock(charId: number, blockedId: number): Promise<void> {
    await this.conn.query('DELETE FROM ipio_woc_blocks WHERE character_id = $1 AND blocked_id = $2', [charId, blockedId]);
  }

  async listBlocks(charId: number): Promise<CharRef[]> {
    const res = await this.conn.query<CharRef>(
      `SELECT c.id, c.name FROM ipio_woc_blocks b JOIN ipio_woc_characters c ON c.id = b.blocked_id
       WHERE b.character_id = $1 ORDER BY c.name`,
      [charId],
    );
    return res.rows;
  }

  async blockedIds(charId: number): Promise<number[]> {
    const res = await this.conn.query<{ blocked_id: number }>('SELECT blocked_id FROM ipio_woc_blocks WHERE character_id = $1', [charId]);
    return res.rows.map((r) => r.blocked_id);
  }

  async createGuildWithLeader(name: string, leaderId: number): Promise<{ guildId: number } | { error: 'name_taken' | 'already_in_guild' }> {
    return withClient(this.conn.connectionString, async (client) => {
      try {
        await client.query('BEGIN');
        let guildId: number;
        try {
          const res = await client.query('INSERT INTO ipio_woc_guilds (name, realm) VALUES ($1, $2) RETURNING id', [name, this.realm]);
          guildId = (res.rows[0] as { id: number }).id;
        } catch (err) {
          await client.query('ROLLBACK');
          if ((err as { code?: string }).code === '23505') return { error: 'name_taken' }; // unique (realm, name)
          throw err;
        }
        // guild_members.character_id is the PK, so this seats the leader only if
        // they are not already in a guild; 0 rows => roll the new guild back so no
        // orphaned, leaderless guild is left behind.
        const mem = await client.query(
          `INSERT INTO ipio_woc_guild_members (guild_id, character_id, rank) VALUES ($1, $2, 'leader')
           ON CONFLICT (character_id) DO NOTHING`,
          [guildId, leaderId],
        );
        if (mem.rowCount === 0) { await client.query('ROLLBACK'); return { error: 'already_in_guild' }; }
        await client.query('COMMIT');
        return { guildId };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  async deleteGuild(id: number): Promise<void> {
    await this.conn.query('DELETE FROM ipio_woc_guilds WHERE id = $1', [id]);
  }

  async guildMembership(charId: number): Promise<{ guildId: number; guildName: string; rank: GuildRank } | null> {
    const res = await this.conn.query<{ guild_id: number; guild_name: string; rank: GuildRank }>(
      `SELECT gm.guild_id, g.name AS guild_name, gm.rank
       FROM ipio_woc_guild_members gm JOIN ipio_woc_guilds g ON g.id = gm.guild_id
       WHERE gm.character_id = $1`,
      [charId],
    );
    const row = res.rows[0];
    return row ? { guildId: row.guild_id, guildName: row.guild_name, rank: row.rank } : null;
  }

  async addGuildMemberAtomic(guildId: number, charId: number, rank: GuildRank, limit: number): Promise<'ok' | 'full' | 'already_member' | 'no_guild'> {
    return withClient(this.conn.connectionString, async (client) => {
      try {
        await client.query('BEGIN');
        // lock the guild row so concurrent accepts serialize — without this the
        // count-then-insert races and N pending invitees can all pass the cap.
        const g = await client.query('SELECT id FROM ipio_woc_guilds WHERE id = $1 FOR UPDATE', [guildId]);
        if (g.rowCount === 0) { await client.query('ROLLBACK'); return 'no_guild'; }
        const existing = await client.query('SELECT 1 FROM ipio_woc_guild_members WHERE character_id = $1', [charId]);
        if ((existing.rowCount ?? 0) > 0) { await client.query('ROLLBACK'); return 'already_member'; }
        const cnt = await client.query('SELECT count(*)::int AS n FROM ipio_woc_guild_members WHERE guild_id = $1', [guildId]);
        if ((cnt.rows[0] as { n: number }).n >= limit) { await client.query('ROLLBACK'); return 'full'; }
        // ON CONFLICT guards the gap between the membership check above and this
        // insert: if the character joined a guild concurrently, the character_id
        // PK conflicts -> 0 rows -> report already_member instead of throwing.
        const ins = await client.query(
          `INSERT INTO ipio_woc_guild_members (guild_id, character_id, rank) VALUES ($1, $2, $3)
           ON CONFLICT (character_id) DO NOTHING`,
          [guildId, charId, rank],
        );
        if (ins.rowCount === 0) { await client.query('ROLLBACK'); return 'already_member'; }
        await client.query('COMMIT');
        return 'ok';
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  async removeGuildMember(charId: number): Promise<void> {
    await this.conn.query('DELETE FROM ipio_woc_guild_members WHERE character_id = $1', [charId]);
  }

  async setGuildRank(charId: number, rank: GuildRank): Promise<void> {
    await this.conn.query('UPDATE ipio_woc_guild_members SET rank = $2 WHERE character_id = $1', [charId, rank]);
  }

  async guildMembers(guildId: number): Promise<(CharInfo & { rank: GuildRank })[]> {
    const res = await this.conn.query<CharInfo & { rank: GuildRank }>(
      `SELECT c.id, c.name, c.class AS cls, c.level, c.realm, gm.rank
       FROM ipio_woc_guild_members gm JOIN ipio_woc_characters c ON c.id = gm.character_id
       WHERE gm.guild_id = $1 ORDER BY gm.joined_at`,
      [guildId],
    );
    return res.rows;
  }
}
