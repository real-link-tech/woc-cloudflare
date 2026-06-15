-- M2 social schema: friends, ignore/block, guilds. Keyed by character id
-- (ipio_woc_characters). Mirrors the original WoC social_db.ts SOCIAL_SCHEMA,
-- prefixed ipio_woc_ and referencing our characters table.
CREATE TABLE IF NOT EXISTS ipio_woc_friendships (
  character_id BIGINT NOT NULL REFERENCES ipio_woc_characters(id) ON DELETE CASCADE,
  friend_id BIGINT NOT NULL REFERENCES ipio_woc_characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, friend_id),
  CHECK (character_id <> friend_id)
);
CREATE INDEX IF NOT EXISTS ipio_woc_friendships_friend ON ipio_woc_friendships(friend_id);

CREATE TABLE IF NOT EXISTS ipio_woc_blocks (
  character_id BIGINT NOT NULL REFERENCES ipio_woc_characters(id) ON DELETE CASCADE,
  blocked_id BIGINT NOT NULL REFERENCES ipio_woc_characters(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (character_id, blocked_id),
  CHECK (character_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS ipio_woc_guilds (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  realm TEXT NOT NULL DEFAULT 'Claudemoon',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ipio_woc_guilds_realm_name ON ipio_woc_guilds(realm, name);

CREATE TABLE IF NOT EXISTS ipio_woc_guild_members (
  character_id BIGINT PRIMARY KEY REFERENCES ipio_woc_characters(id) ON DELETE CASCADE,
  guild_id BIGINT NOT NULL REFERENCES ipio_woc_guilds(id) ON DELETE CASCADE,
  rank TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ipio_woc_guild_members_guild ON ipio_woc_guild_members(guild_id);
