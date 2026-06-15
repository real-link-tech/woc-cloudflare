-- M1 schema for woc-cloudflare. Characters are owned by an IPIO Clerk user
-- (text id from the JWT sub), NOT a woc-local account. Single realm for M1.
CREATE TABLE IF NOT EXISTS ipio_woc_characters (
  id BIGSERIAL PRIMARY KEY,
  ipio_user_id TEXT NOT NULL,
  realm TEXT NOT NULL DEFAULT 'Claudemoon',
  name TEXT NOT NULL,
  class TEXT NOT NULL,
  level INT NOT NULL DEFAULT 1,
  state JSONB,
  is_gm BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ipio_woc_characters_user ON ipio_woc_characters(ipio_user_id, realm);
CREATE UNIQUE INDEX IF NOT EXISTS ipio_woc_characters_name_realm ON ipio_woc_characters(realm, lower(name));

CREATE TABLE IF NOT EXISTS ipio_woc_play_sessions (
  id BIGSERIAL PRIMARY KEY,
  ipio_user_id TEXT NOT NULL,
  character_id BIGINT REFERENCES ipio_woc_characters(id) ON DELETE SET NULL,
  character_name TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ipio_woc_play_sessions_user ON ipio_woc_play_sessions(ipio_user_id);

CREATE TABLE IF NOT EXISTS ipio_woc_world_state (
  realm TEXT NOT NULL,
  key TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, key)
);
