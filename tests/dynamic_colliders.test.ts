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

  it('a measured footprint sizes the collider (× scale), not the base radius', () => {
    // footprint 2 (unscaled) × scale 2 = radius 4. A point 3 units away — clear
    // of the base-radius circle (0.5*2=1) but inside the footprint circle — blocks.
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 2, footprint: 2 })]);
    expect(isBlocked(SEED, OPEN.x + 3, OPEN.z, 0.5)).toBe(true);
    // base-radius equivalent (no footprint) would NOT block at 3 units:
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 2 })]);
    expect(isBlocked(SEED, OPEN.x + 3, OPEN.z, 0.5)).toBe(false);
  });

  it('mesh-BBOX bounds make an anisotropic box collider (× scale)', () => {
    // A long-thin prop: hw 3 (X), hd 0.5 (Z), scale 1, rot 0 → a 6×1 box.
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 1, rot: 0, hw: 3, hd: 0.5 })]);
    // Wide axis (X): blocked out to ~hw+body = 3.5.
    expect(isBlocked(SEED, OPEN.x + 2.8, OPEN.z, 0.5)).toBe(true);
    // Narrow axis (Z): clear just past hd+body = 1.0 — a circle would still block here.
    expect(isBlocked(SEED, OPEN.x, OPEN.z + 1.4, 0.5)).toBe(false);
    // ...and the wide axis still blocks at the same Z offset a circle couldn't reach.
    expect(isBlocked(SEED, OPEN.x + 2.8, OPEN.z, 0.5)).toBe(true);
  });

  it('box scales with placement scale', () => {
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 2, rot: 0, hw: 1, hd: 1 })]);
    // hw 1 × scale 2 = 2; a point 1.8 away on X is inside 2+body.
    expect(isBlocked(SEED, OPEN.x + 1.8, OPEN.z, 0.5)).toBe(true);
  });

  it('centre offset (cx/cz) recentres the box off the origin', () => {
    // Box centred 4 units +X of the placement origin: the origin itself is clear,
    // the shifted box blocks around x+4.
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 1, rot: 0, hw: 1, hd: 1, cx: 4, cz: 0 })]);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(false);     // origin clear
    expect(isBlocked(SEED, OPEN.x + 4, OPEN.z, 0.5)).toBe(true);  // box is over here
  });

  it('clearing the set restores walkability', () => {
    setDynamicColliders(SEED, [worldObjectCollider({ x: OPEN.x, z: OPEN.z, scale: 3 })]);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(true);
    setDynamicColliders(SEED, []);
    expect(isBlocked(SEED, OPEN.x, OPEN.z, 0.5)).toBe(false);
  });
});
