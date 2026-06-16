# Behavior Devices — Implementation Plan (signal-wiring, no-code)

**Goal:** Player-built objects can carry **devices** wired together by **signals**,
so players build mechanisms: pressure-plate→door, button→elevator, trigger→turret,
timer/logic→spawner. Safe (no code execution), deterministic, server-authoritative,
multiplayer-synced. This is the redstone / Fortnite-Devices tier.

(Zelda-style free-form *physical* assembly needs a deterministic rigid-body
physics engine — a separate later epic. Kinematic "mover" devices here approximate
some of it without physics.)

## Architecture

A `WorldObject` may carry a `behavior`:
```ts
behavior?: {
  device: DeviceType,     // 'button'|'plate'|'trigger'|'timer'|'logic'|'door'|'turret'|'spawner'|...
  params: Record<string, number|string>, // device-specific (range, period, gate, openLift, mob, ...)
  inputs: string[],       // wired source object ids (this device's signal input)
}
```

**Runtime** lives in the DO (it has both `worldObjects` and the `sim`). Each tick
(`tickDevices(dt)`):
1. Every device computes a boolean output `out` from its type + params + the
   PREVIOUS tick's outputs of its `inputs` (1-tick propagation per hop ⇒
   deterministic, bounded, loop-proof — redstone-style).
   - Emitters: `button` pulses on interact; `plate` on while an entity stands in
     radius; `trigger` on while an entity is inside radius; `timer` pulses every
     `period` (or delays its input); `logic` = AND/OR/NOT of inputs.
   - Receivers read `powered` = OR of their wired sources' previous `out`:
     `door` opens (kinematic lift/slide + collider off) while powered; `turret`
     (always-on if no inputs, else while powered) auto-targets nearest hostile
     entity/structure in range and shoots on cooldown (reuses combat `dealDamage`
     + projectile VFX); `spawner` spawns a mob on the rising edge of `powered`.
2. Apply receiver effects, then swap the output buffer for next tick.

**Persistence:** `behavior` (device+params+inputs) persists on the WorldObject in
world_state. Transient runtime state (door phase, timer phase, turret cooldown)
lives in the DO's device runtime and re-derives on load.

**Sync/visuals:** a door/mover changes its WorldObject transform → broadcast
`world_object op:'update'` (clients already reconcile transforms). Turret shots →
existing damage events + a projectile VFX. Spawned mobs → normal entity snapshots.

**Wire model:** `target.inputs = [sourceId, ...]`. A `logic` device combines them
by `params.gate` (and/or/not); every other receiver treats input as OR.

## Wire protocol additions
- `WorldObject.behavior` field (server + client).
- cmd `set_behavior {id, device, params}` (owner/GM-gated like edits).
- cmd `wire {fromId, toId}` / `unwire {fromId, toId}` (owner-gated on `toId`).
- cmd `interact_object {id}` → button press (server validates proximity).
- Devices that move broadcast `op:'update'`; otherwise behavior rides `add`/`update`.

## Increments
1. **Runtime + plate→door** (foundational): behavior model + persistence + the
   tick runtime + `plate` (emitter) + `door` (receiver: kinematic open + collider
   off) + `wire`/`set_behavior` cmds. E2E: stand on plate → wired door opens +
   collider drops; step off → closes. (Verified via cmds, no UI yet.)
2. **button + trigger + timer + logic** (the signal toolbox).
3. **turret + spawner** (combat devices) — reuse dealDamage + mob spawn.
4. **Build-mode UX**: a Behavior panel on the selected object (device + params) +
   a Wire tool (click source→target, render wires).
5. Kinematic movers: elevator/rotating platform/piston (later, same runtime).

## Safety/determinism invariants
- No code execution — only the fixed device primitives.
- 1-tick signal propagation (read previous outputs) ⇒ no infinite loops, no
  topo-sort, fully deterministic.
- Per-tick device work is bounded (turret range query via the spatial grid;
  caps on devices/turret-fire-rate). Spawner respects the realm object/mob caps.
- Combat destruction of a device removes its behavior with the object.
