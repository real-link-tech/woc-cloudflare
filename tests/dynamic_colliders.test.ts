import { afterEach, describe, expect, it } from 'vitest';
import {
  isBlocked, resolvePosition, setDynamicColliders, worldObjectCollider,
} from '../src/sim/colliders';

// Use an out-of-town, open-field seed/coordinate well away from any static
// prop or dungeon so the only collider in play is the one we add dynamically.
const SEED = 20061;
const OPEN = { x: 412.3, z: -377.1 }; // arbitrary open ground far from origin

afterEach(() => setDynamicColliders(SEED, [])); // never leak across tests

describe('dynamic (player-placed) colliders', () => {
  it('open ground is walkable with no placed objects', () => {
    setDynamicColliders(SEED, []);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(false);
    const res = resolvePosition(SEED, OPEN.x, OPEN.z, 0.5);
    expect(res.x).toBeCloseTo(OPEN.x, 6);
    expect(res.z).toBeCloseTo(OPEN.z, 6);
  });

  it('a placed object blocks the tile it stands on', () => {
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 3 })]);
    // Standing inside the footprint (radius 0.5*3=1.5) must be pushed out.
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(true);
    const res = resolvePosition(SEED, OPEN.x, OPEN.z, 0.5);
    const pushedDist = Math.hypot(res.x - OPEN.x, res.z - OPEN.z);
    // pushed to the collider edge: r(1.5) + body(0.5) = 2.0 from centre
    expect(pushedDist).toBeGreaterThan(1.9);
  });

  it('larger scale yields a larger blocking footprint', () => {
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 6 })]);
    // A point 2.5 units away clears a scale-3 prop but not a scale-6 one (r=3).
    const probe = { x: OPEN.x + 2.5, z: OPEN.z };
    expect(isBlocked(SEED, probe.x, probe.z, 0.5)).toBe(true);
  });

  it('clearing the set restores walkability', () => {
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 3 })]);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(true);
    setDynamicColliders(SEED, []);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(false);
  });
});
