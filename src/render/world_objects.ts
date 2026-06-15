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

// Unscaled XZ footprint radius per glbUrl, measured from the parsed model so the
// server's collision circle can match the model's real size (× placement scale)
// instead of a one-size-fits-all guess. Populated whenever a model is loaded
// (preview or spawn); read synchronously at place time via footprintFor().
const footprintCache = new Map<string, number>();
function measureFootprint(url: string, scene: THREE.Object3D): number {
  let r = footprintCache.get(url);
  if (r !== undefined) return r;
  const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
  // half the larger horizontal extent — a circle that covers the model's wider
  // side. Guard against empty/degenerate boxes (Infinity from no geometry).
  r = Number.isFinite(size.x) && Number.isFinite(size.z) ? Math.max(size.x, size.z) / 2 : 0;
  footprintCache.set(url, r);
  return r;
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
      measureFootprint(glbUrl, gltf.scene); // cache footprint for place-time collision
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
      }
    }
    // Add objects we don't have yet (and aren't already loading).
    for (const obj of desired.values()) {
      if (this.rendered.has(obj.id) || this.pending.has(obj.id)) continue;
      this.pending.add(obj.id);
      void this.spawn(obj, desired);
    }
  }

  private async spawn(obj: WorldObject, desired: Map<string, WorldObject>): Promise<void> {
    try {
      const gltf = await loadGlb(obj.glbUrl);
      measureFootprint(obj.glbUrl, gltf.scene); // keep footprint cache warm
      // Bail if it was removed (or somehow already added) while loading.
      if (!desired.has(obj.id) || this.rendered.has(obj.id)) return;
      const group = gltf.scene.clone(true);
      const y = groundHeight(obj.x, obj.z, this.seed) + obj.y;
      group.position.set(obj.x, y, obj.z);
      group.rotation.y = obj.rot;
      group.scale.setScalar(obj.scale);
      group.userData.worldObjectId = obj.id;
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

  // The currently-rendered object groups, for build-mode delete raycasting.
  objects(): THREE.Object3D[] {
    return [...this.rendered.values()];
  }

  // Unscaled XZ footprint radius for a glbUrl, if it has been loaded (preview or
  // spawn). Sent with place_object so the server's collider matches the model's
  // real size. Undefined until the model loads — the server falls back to a base
  // radius, which the preview/selection always populates before a click.
  footprintFor(glbUrl: string): number | undefined {
    return footprintCache.get(glbUrl);
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
