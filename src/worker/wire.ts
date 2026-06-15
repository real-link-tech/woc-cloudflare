// Pure wire-serialization helpers, copied verbatim from the Node authoritative
// server (server/game.ts:146-230). They depend only on the deterministic Sim's
// Entity shape and the threat helper, so they port unchanged. The field names
// are the wire contract consumed by the client (src/net/online.ts) — do NOT
// rename them.
import type { Entity } from '../sim/types';
import { threatEntries } from '../sim/threat';

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// Identity fields rarely change, so they ride only in "full" records: on an
// entity's first snapshot for a session and again whenever one of them changes.
// The client treats their absence in a record as "unchanged".
export function identityFields(e: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = { k: e.kind, tid: e.templateId, nm: e.name, lv: e.level };
  if (e.dungeonId) out.dgn = e.dungeonId;
  if (e.scale !== 1) out.sc = e.scale;
  if (e.color !== 0xffffff) out.c = e.color;
  return out;
}

// Dynamic fields are re-sent whole in every record, so the conditional ones
// keep their absent-means-unset semantics.
export function dynamicFields(e: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {
    x: round2(e.pos.x), y: round2(e.pos.y), z: round2(e.pos.z), f: round2(e.facing),
    hp: e.hp, mhp: e.maxHp,
  };
  if (e.dead) out.dead = 1;
  if (e.lootable) out.loot = 1;
  if (e.hostile) out.h = 1;
  if (e.castingAbility) {
    out.cast = e.castingAbility;
    out.castRem = round2(e.castRemaining);
    out.castTot = round2(e.castTotal);
    if (e.channeling) out.chan = 1;
  }
  if (e.sitting || e.eating || e.drinking) out.sit = 1;
  if (e.aggroTargetId !== null) out.aggro = e.aggroTargetId;
  if (e.tappedById !== null) out.tap = e.tappedById;
  if (e.ownerId !== null) out.own = e.ownerId;
  // top hate-table entries so the party threat meter shows real numbers
  if (e.kind === 'mob' && !e.dead && e.threat.size > 0) out.thr = threatEntries(e, 8);
  if (e.auras.length > 0) {
    out.auras = e.auras.map((a) => ({ id: a.id, name: a.name, kind: a.kind, rem: round2(a.remaining), dur: a.duration }));
  }
  if (e.kind === 'mob' && e.lootable && e.loot) {
    out.lootList = { copper: e.loot.copper, items: e.loot.items };
  }
  return out;
}

export function wireEntity(e: Entity): Record<string, unknown> {
  return { id: e.id, ...identityFields(e), ...dynamicFields(e) };
}
