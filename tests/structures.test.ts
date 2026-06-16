import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import type { SimEvent } from '../src/sim/types';

function makeSim() {
  return new Sim({ seed: 7, playerClass: 'warrior', autoEquip: true });
}

describe('destructible structures', () => {
  it('addStructure creates a neutral, attackable hitbox at full HP', () => {
    const sim = makeSim();
    const p = sim.player;
    const id = sim.addStructure('wo_a', { x: p.pos.x + 2, y: p.pos.y, z: p.pos.z }, 80, 'Wall');
    const st = sim.entities.get(id)!;
    expect(st.kind).toBe('structure');
    expect(st.structureId).toBe('wo_a');
    expect(st.hp).toBe(80);
    expect(st.maxHp).toBe(80);
    expect(st.hostile).toBe(false);
    expect(sim.isHostileTo(p, st)).toBe(true);          // any player may attack
    expect(sim.structureIdOf(id)).toBe('wo_a');
  });

  it('is idempotent and movable/removable', () => {
    const sim = makeSim();
    const p = sim.player;
    const id1 = sim.addStructure('wo_b', { x: p.pos.x + 3, y: 0, z: p.pos.z }, 60, 'B');
    const id2 = sim.addStructure('wo_b', { x: p.pos.x + 3, y: 0, z: p.pos.z }, 60, 'B'); // same id
    expect(id2).toBe(id1);
    sim.moveStructure('wo_b', { x: p.pos.x + 9, y: 0, z: p.pos.z });
    expect(sim.entities.get(id1)!.pos.x).toBeCloseTo(p.pos.x + 9, 1);
    sim.removeStructure('wo_b');
    expect(sim.entities.has(id1)).toBe(false);
  });

  it('a player auto-attacking a structure destroys it (death event)', () => {
    const sim = makeSim();
    const p = sim.player;
    const id = sim.addStructure('wo_c', { x: p.pos.x + 2, y: p.pos.y, z: p.pos.z }, 40, 'Hut');
    sim.targetEntity(id, p.id);
    sim.startAutoAttack(p.id);
    let died = false;
    for (let i = 0; i < 600 && !died; i++) {
      const evs: SimEvent[] = sim.tick();
      for (const e of evs) if (e.type === 'death' && e.entityId === id) died = true;
    }
    expect(died).toBe(true);
    // the structure entity reports its WorldObject id so the DO can remove it
    expect(sim.entities.get(id)?.dead).toBe(true);
  });
});
