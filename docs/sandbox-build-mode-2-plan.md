# Sandbox Building (Build Mode 2.0) — Implementation Plan

**Goal:** A complete, reliable in-world sandbox builder — place / select / move / rotate / scale / delete IPIO library assets, with grid snap, multi-select, undo/redo, copy/paste, and owner/GM permissions. Collision (OBB), persistence, and multiplayer sync already work.

**Architecture:**
- **Client** `BuildController` (`src/game/build.ts`) owns build state: tool (`off|place|select`), selection set, ghost asset, scale, yaw, grid-snap, undo/redo stack, clipboard. main.ts wires input + frame loop to it; hud.ts renders the toolbar/palette.
- **Server** (realm-do.ts): objects get a stable `ownerId`; `remove_object` + a new `update_object` op are permission-gated (`owner || GM`). Reuses existing collider-sync + persistence.
- **Wire:** `WorldObject.ownerId:number`; `place_object` stamps it; `remove_object`/`update_object` checked; broadcast `world_object op:add|remove|update`.

**Tech stack:** TS, Three.js, Cloudflare DO + Postgres, vitest + Playwright e2e on woc-dev.

**Permissions:** edit/delete allowed when `obj.ownerId === conn.characterId || conn.isGm`. Legacy objects (no `ownerId`) are unowned → anyone may edit (so existing builds aren't locked).

---

## Phase 0 — Server: ownership, permissions, update op

### Task 0.1 — ownerId on objects + isGm on Conn
- Modify `WorldObject` (realm-do.ts + online.ts): add `ownerId?: number`.
- Add `isGm: boolean` to `Conn`; set from `character.is_gm` at connect.
- `placeObject`: stamp `ownerId: conn.characterId`.

### Task 0.2 — permission gate
- Helper `canEditObject(conn, obj)`: `obj.ownerId === undefined || obj.ownerId === conn.characterId || conn.isGm`.
- `removeObject(conn, id)`: gate; `sendErr` "You can only remove what you placed." on deny.

### Task 0.3 — update_object op
- `case 'update_object'`: `{id, x,z,rot,scale}` → find obj, `canEditObject` gate, validate numbers (same bounds as place; bounds hw/hd/cx/cz unchanged), mutate, `syncWorldObjectColliders()`, broadcast `{t:'world_object', op:'update', obj}`, `saveWorldObjects()`.
- Client `online.updateWorldObject({id,x,z,rot,scale})`; apply `op:'update'` in onMessage (replace in `worldObjects` map, flag changed).

### Task 0.4 — tests
- vitest (pure perm helper). Live e2e: place→ownerId set; non-owner remove denied; update moves + collider re-syncs.

---

## Phase 1 — Client build controller + click fix + selection

### Task 1.1 — BuildController (`src/game/build.ts`)
- State: `tool`, `asset` (ghost), `scale`, `yaw`, `gridSnap`, `selected:Set<string>`, `undo[]`, `redo[]`, `clipboard`.
- Methods: enterPlace(asset)/enterSelect()/exit(); setScale/rotateBy/toggleGrid; select(id, additive)/clearSelection; pushAction/undo/redo; copy/paste. Emits ops via injected `online` calls.

### Task 1.2 — fix click routing + palette UX
- Build panel must not eat build-area clicks: collapse the palette to a compact rail while a tool is active, and/or close-on-place. Confirm `onClickPick` reaches handlePick over the 3D view.
- Build toolbar (hud): mode buttons Place / Select / Rotate / Grid / Undo / Redo / Delete + scale & yaw readout; clear Exit.

### Task 1.3 — selection + highlight
- Click a placed object in Select tool → select + outline highlight (emissive or outline pass). Shift-click = add (multi-select). Empty click = clear.
- `WorldObjectsLayer.setHighlight(ids)`.

---

## Phase 2 — Placement transforms

### Task 2.1 — rotate while placing
- `buildYaw` (Q/E step ±15°, Shift+wheel fine). Thread into ghost `updatePreview(x,z,yaw,scale)` and `place_object.rot`.

### Task 2.2 — grid snap
- `gridSnap` toggle (e.g. 1u). Snap ghost + placement x/z (and yaw to 15°). Toolbar toggle + hint.

---

## Phase 3 — Edit placed objects

### Task 3.1 — transform selected
- Selected object(s): move (drag on ground plane, or arrow keys), rotate (Q/E), scale (wheel), delete (Del). Each emits `update_object` (or `remove`).
- Debounce drag → send `update_object` on release (and optimistic local preview).

### Task 3.2 — transform panel
- hud panel for the selection: numeric x/z/rot/scale + Delete + Duplicate buttons.

---

## Phase 4 — Creative tools

### Task 4.1 — undo/redo
- Action stack of invertible build ops (place↔remove, delete↔place, transform↔transform-back). Ctrl+Z / Ctrl+Y + toolbar.

### Task 4.2 — copy/paste / duplicate
- Ctrl+C/V or Duplicate button: clone selected at cursor (+ small offset), new ownerId = me.

### Task 4.3 — multi-select transforms
- Box/shift select; transforms apply to the set about its centroid.

---

## Verification (each phase ships + is tested)
- vitest for pure logic (permissions, grid snap math, undo invertibility, controller transitions).
- Playwright e2e on woc-dev per phase: drive `__game.build`/`online`, assert server + collider + persistence effects; clean up only self-placed test objects (never blanket-delete a realm).
- Commit + push each landed increment; deploy to woc-dev.
