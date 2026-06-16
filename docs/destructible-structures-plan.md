# Destructible Structures (combat-integrated) — Implementation Plan

**Goal:** Player-built objects can be attacked and destroyed in normal combat —
melee, spells, and AoE all damage them; at 0 HP the structure is destroyed
(removed for everyone) with a debris/poof effect. HP scales with the object's
size. The whole built world is destructible.

**Scope decision (user):** Full combat integration (not a lightweight ad-hoc
"smash" command). Structures become first-class sim combat targets. Terrain/voxel
destruction is explicitly OUT of scope.

---

## Architecture

A placed `WorldObject` (DO-managed) gets a co-located **sim entity** of a new
kind `'structure'` that carries the HP and participates in combat. The GLB is
still rendered by `WorldObjectsLayer`; the structure entity is its invisible
hitbox + health. The DO bridges the two sets.

```
WorldObject (DO set, persisted)  ──spawn/move/despawn──►  Structure entity (sim)
        │ glbUrl, x/z, scale, hw/hd                                │ hp/maxHp, pos, radius
        └──────────────── linked by a stable key ─────────────────┘
   death (hp→0) ──► DO.removeObject(broadcast remove + collider + persist) + 'structure_destroyed' event
```

### Sim (src/sim)
- `types.ts`: add `'structure'` to entity kinds; structures are non-moving,
  non-aggro, neutral, with `hp/maxHp`, a `structureId` (the WorldObject id),
  and a body radius from the footprint.
- `entity.ts`: `createStructure(id, worldObjId, pos, hp, radius)`.
- `sim.ts`:
  - `addStructure/removeStructure/moveStructure` (DO calls these on load/place/
    update/remove).
  - `isHostileTo`: a structure is a valid attack target for any player (neutral
    destructible) — targetable + meleeSwing/spell damage apply.
  - On structure death: don't drop loot/corpse; emit a `SimEvent`
    `{type:'structure_destroyed', structureId}` and mark for removal. The sim
    does NOT delete the WorldObject itself (the DO owns that) — it surfaces the
    event so the DO removes the object.
  - HP: `maxHp = clamp(round(BASE_HP * footprintArea * scale^2))` (bigger →
    tankier). No regen (or slow regen — a config flag).

### DO (src/worker/realm-do.ts)
- On world-objects load + each `placeObject`: `sim.addStructure(...)`.
- `updateObject` (move/scale): `sim.moveStructure(...)` (and rescale HP? keep HP
  fraction on rescale).
- `removeObject`: `sim.removeStructure(id)`.
- Each tick: drain `structure_destroyed` events → `this.removeObject(system, id)`
  (a system actor that bypasses the owner permission — combat destruction is not
  an edit) → broadcasts remove + frees collider + persists + a `world_object`
  `op:'destroyed'` (so clients can play debris vs a plain remove).
- HP persistence: store current hp on the WorldObject so a half-wrecked building
  stays wrecked across reload (optional v1: regenerate to full on realm wake).

### Client
- `online.ts`: structures arrive in snapshots like any entity (hp bar data).
  Handle `world_object op:'destroyed'` → debris/poof at the position, then remove.
- Targeting: clicking a placed GLB (outside build mode) targets its structure
  entity (raycast → worldObjectId → entity with that structureId) so normal
  auto-attack / abilities hit it. Show its HP bar (reuse the nameplate/health UI).
- Build mode is unaffected (build clicks still place/select; combat targeting is
  the non-build click path).

---

## Tasks
1. Sim: `'structure'` kind + createStructure + add/remove/move + HP formula. Unit tests.
2. Sim combat: structures targetable + damageable + death event (no loot/corpse).
   Unit test: attack a structure → hp drops → death event at 0.
3. DO bridge: spawn/move/despawn structures with world objects; drain death events
   → removeObject(system) + `op:'destroyed'` broadcast + persist hp.
4. Client: target a placed object in combat, HP bar, destroy VFX.
5. E2E on woc-dev: place → attack → HP drops → destroyed (removed for all) +
   collider freed; reload shows it gone.

## Open questions (defaults)
- HP persists vs regenerates on reload → **persist** (store hp on WorldObject).
- Can you destroy your own / others' builds → **anyone can destroy** (combat is
  not gated by build-ownership; ownership only gates *editing*). A realm flag
  could later make builds invulnerable ("creative" vs "siege" realms).
- Repair → out of scope v1.
