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

export class WorldObjectsLayer {
  private readonly rendered = new Map<string, THREE.Object3D>();
  // ids whose GLB is mid-flight, so a second reconcile pass before the load
  // resolves doesn't add a duplicate.
  private readonly pending = new Set<string>();

  constructor(private readonly scene: THREE.Scene, private readonly seed: number) {}

  // Diff the desired set (world.worldObjects) against what's currently in the
  // scene: load+add new ones, dispose removed ones. Async (GLB loads), but safe
  // to call repeatedly — pending-load guards prevent double-adds.
  reconcile(world: WorldObjectSource): void {
    const desired = world.worldObjects;
    // Remove objects that are no longer present.
    for (const [id, group] of this.rendered) {
      if (!desired.has(id)) {
        this.scene.remove(group);
        disposeObject(group);
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
