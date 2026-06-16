// "Build the world" render layer: reconciles the player-placed IPIO library
// assets (mirrored into ClientWorld.worldObjects) into THREE meshes in the
// renderer's scene. Objects are static — we only (re)diff when the mirrored set
// changes (the frame loop polls world.consumeWorldObjectsChanged()).
//
// World-object glbUrls are ABSOLUTE external IPIO URLs (assets.ipio.ai /
// api.ipio.ai / api-dev.ipio.ai). The shared loader (./assets/loader) routes
// every url through assetUrl(), which strips leading slashes and looks the
// logical path up in a local media manifest — that mangles a full https:// URL.
// So this layer owns a dedicated GLTFLoader that loads the absolute url as-is,
// mirroring loader.ts's meshopt setup.
import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { groundHeight } from '../sim/world';
import type { WorldObject } from '../net/online';

// Minimal shape this layer needs from ClientWorld — keeps it decoupled from the
// full IWorld surface.
interface WorldObjectSource {
  worldObjects: Map<string, WorldObject>;
}

let sharedLoader: GLTFLoader | null = null;
function objectLoader(): GLTFLoader {
  if (!sharedLoader) {
    sharedLoader = new GLTFLoader();
    sharedLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return sharedLoader;
}

// Parsed-GLB cache keyed by absolute url — every instance clones from one parse.
const glbCache = new Map<string, Promise<GLTF>>();
function loadGlb(url: string): Promise<GLTF> {
  let p = glbCache.get(url);
  if (!p) {
    p = new Promise<GLTF>((resolve, reject) => {
      objectLoader().load(url, resolve, undefined, (err) =>
        reject(err instanceof Error ? err : new Error(`world-object load failed: ${url}`)));
    });
    glbCache.set(url, p);
  }
  return p;
}

// Unscaled mesh bounding-box (BBOX) footprint per glbUrl, measured from the
// parsed model so the server's collider can match the model's real shape
// (× placement scale) instead of a one-size-fits-all guess. hw/hd are XZ
// half-extents; cx/cz is the box centre offset from the model origin (so a model
// whose origin isn't centred still boxes correctly). Populated on every load
// (preview or spawn); read synchronously at place time via boundsFor().
// XZ half-extents (hw/hd) + XZ centre (cx/cz) drive the server collider. The
// full local box (hy/cy too) drives the tight selection outline.
export interface ModelBounds { hw: number; hd: number; hy: number; cx: number; cy: number; cz: number; }
const boundsCache = new Map<string, ModelBounds>();
function measureBounds(url: string, scene: THREE.Object3D): ModelBounds {
  let b = boundsCache.get(url);
  if (b) return b;
  // scene is at identity here, so this is the model's LOCAL box.
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const fin = (n: number) => (Number.isFinite(n) ? n : 0); // guard empty/degenerate boxes
  b = {
    hw: Math.max(0, fin(size.x) / 2), hd: Math.max(0, fin(size.z) / 2), hy: Math.max(0, fin(size.y) / 2),
    cx: fin(ctr.x), cy: fin(ctr.y), cz: fin(ctr.z),
  };
  boundsCache.set(url, b);
  return b;
}

export class WorldObjectsLayer {
  private readonly rendered = new Map<string, THREE.Object3D>();
  // ids whose GLB is mid-flight, so a second reconcile pass before the load
  // resolves doesn't add a duplicate.
  private readonly pending = new Set<string>();
  // Build-mode placement preview: a translucent ghost of the selected asset that
  // follows the cursor on the ground (WoW/WC3-style building placement). Scale +
  // rotation are previewed live before the click commits.
  private preview: THREE.Object3D | null = null;
  private previewUrl: string | null = null;
  private previewToken = 0;
  // Selection highlight: a bright wireframe box per selected object, parented to
  // the object so it inherits rotation/scale and tightly bounds the mesh (an
  // oriented box, not a loose world-AABB). Doesn't touch the GLB's materials.
  private readonly highlights = new Map<string, THREE.LineSegments>();

  constructor(private readonly scene: THREE.Scene, private readonly seed: number) {}

  // Show a translucent preview of `glbUrl`. Idempotent for the same url. Position
  // it with updatePreview(); remove it with clearPreview().
  async setPreview(glbUrl: string): Promise<void> {
    if (this.previewUrl === glbUrl && this.preview) return;
    this.clearPreview();
    this.previewUrl = glbUrl;
    const token = ++this.previewToken;
    try {
      const gltf = await loadGlb(glbUrl);
      measureBounds(glbUrl, gltf.scene); // cache mesh BBOX for place-time collision
      if (token !== this.previewToken) return; // superseded by a newer selection
      const ghost = gltf.scene.clone(true);
      // Clone materials (the cache shares them across instances) and make them a
      // translucent blue-tinted ghost. depthWrite off so it reads as a hologram.
      ghost.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const ghostMat = (m: THREE.Material): THREE.Material => {
          const c = m.clone();
          const std = c as THREE.MeshStandardMaterial;
          std.transparent = true;
          std.opacity = 0.5;
          std.depthWrite = false;
          if (std.emissive) { std.emissive.setHex(0x2b6cff); std.emissiveIntensity = 0.4; }
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(ghostMat) : ghostMat(mesh.material);
      });
      ghost.visible = false; // until first updatePreview positions it
      this.preview = ghost;
      this.scene.add(ghost);
    } catch (err) {
      console.warn('[world-objects] preview load failed', glbUrl, err);
    }
  }

  // Move/scale/rotate the preview to a ground position.
  updatePreview(x: number, z: number, rot: number, scale: number): void {
    if (!this.preview) return;
    this.preview.position.set(x, groundHeight(x, z, this.seed), z);
    this.preview.rotation.y = rot;
    this.preview.scale.setScalar(scale);
    this.preview.visible = true;
  }

  clearPreview(): void {
    this.previewToken++;
    this.previewUrl = null;
    if (this.preview) {
      this.scene.remove(this.preview);
      // dispose ONLY the cloned preview materials (geometry is shared with the cache).
      this.preview.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat?.dispose();
        }
      });
      this.preview = null;
    }
  }

  // Diff the desired set (world.worldObjects) against what's currently in the
  // scene: load+add new ones, dispose removed ones. Async (GLB loads), but safe
  // to call repeatedly — pending-load guards prevent double-adds.
  reconcile(world: WorldObjectSource): void {
    const desired = world.worldObjects;
    // Remove objects that are no longer present. We do NOT dispose geometry/
    // materials — clone(true) shares them with the cached GLB and other live
    // instances, so disposing here would break re-placing the same asset.
    for (const [id, group] of this.rendered) {
      if (!desired.has(id)) {
        this.scene.remove(group);
        this.rendered.delete(id);
        const box = this.highlights.get(id);
        if (box) { box.parent?.remove(box); box.geometry.dispose(); (box.material as THREE.Material).dispose(); this.highlights.delete(id); }
      }
    }
    // Add new objects (and aren't already loading); re-apply the transform of
    // ones we already render, so an `update_object` (move/rotate/rescale) shows.
    for (const obj of desired.values()) {
      const group = this.rendered.get(obj.id);
      if (group) { this.applyTransform(group, obj); continue; }
      if (this.pending.has(obj.id)) continue;
      this.pending.add(obj.id);
      void this.spawn(obj, desired);
    }
  }

  private applyTransform(group: THREE.Object3D, obj: WorldObject): void {
    const baseY = groundHeight(obj.x, obj.z, this.seed) + obj.y;
    group.userData.baseY = baseY;
    group.userData.objScale = obj.scale;
    group.position.set(obj.x, baseY, obj.z);
    group.rotation.y = obj.rot;
    group.scale.setScalar(obj.scale);
    this.applyDoorOffset(obj.id, group); // lift if this is an open device-door
    group.updateMatrixWorld(true);
    // the selection box is a child of the group, so it follows automatically.
  }

  // Open device-doors rise by their own height so players can pass under them.
  private readonly deviceOpen = new Set<string>();
  private applyDoorOffset(id: string, group: THREE.Object3D): void {
    const baseY = (group.userData.baseY as number) ?? group.position.y;
    let lift = 0;
    if (this.deviceOpen.has(id)) {
      const b = boundsCache.get(group.userData.glbUrl as string);
      const s = (group.userData.objScale as number) || 1;
      lift = ((b ? b.hy * 2 : 2) * s) + 0.2;
    }
    group.position.y = baseY + lift;
  }

  // Server-authoritative set of currently-open device-doors; lift/lower them.
  setDeviceStates(open: Set<string>): void {
    this.deviceOpen.clear();
    for (const id of open) this.deviceOpen.add(id);
    for (const [id, group] of this.rendered) { this.applyDoorOffset(id, group); group.updateMatrixWorld(true); }
  }

  // Show a tight wireframe box around exactly the given object ids (selection).
  // The box is parented to the object and sized to the model's LOCAL bounds, so
  // it hugs the mesh and rotates/scales with it. Idempotent; empty set clears.
  setHighlight(ids: Set<string>): void {
    for (const [id, box] of this.highlights) {
      if (!ids.has(id) || !this.rendered.has(id)) {
        box.parent?.remove(box);
        box.geometry.dispose();
        (box.material as THREE.Material).dispose();
        this.highlights.delete(id);
      }
    }
    for (const id of ids) {
      if (this.highlights.has(id)) continue;
      const group = this.rendered.get(id);
      if (!group) continue;
      const b = boundsCache.get(group.userData.glbUrl as string);
      // BoxGeometry in the group's LOCAL space; parenting makes it inherit the
      // object's yaw + scale → a tight oriented bound. Fall back to a unit box.
      const w = b ? Math.max(b.hw * 2, 0.05) : 1;
      const h = b ? Math.max(b.hy * 2, 0.05) : 1;
      const d = b ? Math.max(b.hd * 2, 0.05) : 1;
      const geom = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
      const mat = new THREE.LineBasicMaterial({ color: 0xffe27a, depthTest: false, transparent: true });
      const box = new THREE.LineSegments(geom, mat);
      if (b) box.position.set(b.cx, b.cy, b.cz); // recentre on the model's box centre
      box.renderOrder = 999;
      group.add(box); // parent to the object → inherits rotation + scale
      this.highlights.set(id, box);
    }
  }

  private async spawn(obj: WorldObject, desired: Map<string, WorldObject>): Promise<void> {
    try {
      const gltf = await loadGlb(obj.glbUrl);
      measureBounds(obj.glbUrl, gltf.scene); // keep BBOX cache warm
      // Bail if it was removed (or somehow already added) while loading.
      if (!desired.has(obj.id) || this.rendered.has(obj.id)) return;
      const group = gltf.scene.clone(true);
      this.applyTransform(group, obj);
      group.userData.worldObjectId = obj.id;
      group.userData.glbUrl = obj.glbUrl; // so setHighlight can size a tight box
      // Tag every descendant mesh too, so a build-mode raycast that hits a child
      // mesh can walk up to find the owning world-object id.
      group.traverse((child) => { child.userData.worldObjectId = obj.id; });
      this.scene.add(group);
      this.rendered.set(obj.id, group);
    } catch (err) {
      // Tolerate a bad/unreachable GLB — log and skip so one failure doesn't
      // wedge the whole layer.
      console.warn('[world-objects] failed to load', obj.glbUrl, err);
    } finally {
      this.pending.delete(obj.id);
    }
  }

  // ---- Destruction debris VFX ---------------------------------------------
  private readonly debris: { obj: THREE.Mesh; v: THREE.Vector3; rv: THREE.Vector3; life: number; mat: THREE.MeshLambertMaterial }[] = [];
  private readonly debrisGeom = new THREE.BoxGeometry(1, 1, 1);
  private static readonly DEBRIS_COLORS = [0xa89878, 0x8a7a5a, 0xb8a888, 0x6f5f45];

  // Burst of tumbling chunks when a structure is destroyed (scales with size).
  spawnDebris(p: { x: number; y: number; z: number; scale: number }): void {
    const baseY = groundHeight(p.x, p.z, this.seed) + p.y;
    const n = Math.min(26, 10 + Math.floor(p.scale * 2.5));
    const size = 0.18 * Math.max(0.5, p.scale);
    for (let i = 0; i < n; i++) {
      const color = WorldObjectsLayer.DEBRIS_COLORS[i % WorldObjectsLayer.DEBRIS_COLORS.length];
      const mat = new THREE.MeshLambertMaterial({ color });
      const m = new THREE.Mesh(this.debrisGeom, mat);
      m.scale.setScalar(size * (0.6 + Math.random() * 0.9));
      m.position.set(p.x + (Math.random() - 0.5) * 0.6 * p.scale, baseY + 0.4 * p.scale, p.z + (Math.random() - 0.5) * 0.6 * p.scale);
      const ang = Math.random() * Math.PI * 2, spd = 2 + Math.random() * 3.5;
      this.debris.push({
        obj: m, mat,
        v: new THREE.Vector3(Math.cos(ang) * spd, 3.5 + Math.random() * 3.5, Math.sin(ang) * spd),
        rv: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
        life: 0.9 + Math.random() * 0.5,
      });
      this.scene.add(m);
    }
  }

  // Turret/trap tracer bolts: a short bright line that fades fast.
  private readonly tracers: { obj: THREE.Line; mat: THREE.LineBasicMaterial; life: number }[] = [];
  spawnTracer(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z),
    ]);
    const mat = new THREE.LineBasicMaterial({ color: 0xffd060, transparent: true, depthTest: false });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 998;
    this.scene.add(line);
    this.tracers.push({ obj: line, mat, life: 0.18 });
  }

  // Advance the debris + tracer simulation. Call once per frame from the loop.
  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) { this.scene.remove(t.obj); t.obj.geometry.dispose(); t.mat.dispose(); this.tracers.splice(i, 1); continue; }
      t.mat.opacity = Math.min(1, t.life / 0.18);
    }
    if (!this.debris.length) return;
    const step = Math.min(dt, 0.05);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) { this.scene.remove(d.obj); d.mat.dispose(); this.debris.splice(i, 1); continue; }
      d.v.y -= 18 * step; // gravity
      d.obj.position.addScaledVector(d.v, step);
      const gy = groundHeight(d.obj.position.x, d.obj.position.z, this.seed);
      if (d.obj.position.y < gy + 0.05) { d.obj.position.y = gy + 0.05; d.v.y *= -0.35; d.v.x *= 0.55; d.v.z *= 0.55; } // bounce
      d.obj.rotation.x += d.rv.x * step; d.obj.rotation.y += d.rv.y * step; d.obj.rotation.z += d.rv.z * step;
      const fade = Math.min(1, d.life / 0.4); // fade out in the last 0.4s
      d.mat.opacity = fade; d.mat.transparent = fade < 1;
    }
  }

  // Build-mode wire overlay: bright lines from each signal source → its target.
  private wireGroup: THREE.Group | null = null;
  setWires(pairs: { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number } }[]): void {
    if (this.wireGroup) { this.scene.remove(this.wireGroup); this.wireGroup.traverse((o) => { const l = o as THREE.Line; l.geometry?.dispose(); }); this.wireGroup = null; }
    if (!pairs.length) return;
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x57e0ff, transparent: true, opacity: 0.8, depthTest: false });
    for (const p of pairs) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p.from.x, p.from.y, p.from.z), new THREE.Vector3(p.to.x, p.to.y, p.to.z),
      ]);
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 997;
      g.add(line);
    }
    this.wireGroup = g;
    this.scene.add(g);
  }

  // The currently-rendered object groups, for build-mode delete raycasting.
  objects(): THREE.Object3D[] {
    return [...this.rendered.values()];
  }

  // Unscaled mesh-BBOX bounds for a glbUrl, if it has been loaded (preview or
  // spawn). Sent with place_object so the server's collider box matches the
  // model. Undefined until the model loads — the server falls back to a base
  // radius, which the preview/selection always populates before a click.
  boundsFor(glbUrl: string): ModelBounds | undefined {
    return boundsCache.get(glbUrl);
  }

  // Raycast the placed-object groups at a screen point and return the owning
  // world-object id, or null. Used by build mode to pick an object to delete.
  // Takes the renderer's raycaster + camera so it shares the live view matrices.
  pickWorldObjectId(
    raycaster: THREE.Raycaster,
    camera: THREE.Camera,
    clientX: number,
    clientY: number,
  ): string | null {
    if (this.rendered.size === 0) return null;
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(this.objects(), true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o) {
        const id = o.userData.worldObjectId;
        if (typeof id === 'string') return id;
        o = o.parent;
      }
    }
    return null;
  }
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    }
  });
}
