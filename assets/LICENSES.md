# Third-party asset licences

The project code is MIT (see [`../LICENSE`](../LICENSE)). The processed 3D models
in `apps/web/public/assets/models/` come from the CC0 packs below. CC0 1.0 places
the assets in the public domain; attribution is not required, but we record it
anyway so the provenance stays auditable.

## Kenney — Furniture Kit (2.0)

- Author: Kenney (https://www.kenney.nl)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/
- Source: https://kenney.nl/assets/furniture-kit
- Source archive SHA-256: `e67652d0932cee41683f74711c03d3e192a2af9979ef8e6b237711f5482d46b0`
- Processed files, in-pack source path -> processed path:
  - `Models/GLTF format/desk.glb` -> `apps/web/public/assets/models/desk.glb`
  - `Models/GLTF format/chairDesk.glb` -> `apps/web/public/assets/models/chairDesk.glb`
  - `Models/GLTF format/computerScreen.glb` -> `apps/web/public/assets/models/computerScreen.glb`
  - `Models/GLTF format/computerKeyboard.glb` -> `apps/web/public/assets/models/computerKeyboard.glb`
  - `Models/GLTF format/computerMouse.glb` -> `apps/web/public/assets/models/computerMouse.glb`

## Kenney — Mini Characters (2.0)

- Author: Kenney (https://www.kenney.nl)
- Licence: CC0 1.0 — https://creativecommons.org/publicdomain/zero/1.0/
- Source: https://kenney.nl/assets/mini-characters
- Source archive SHA-256: `add348e98ab9e23d9973c4740ef2c5cceb229c742106aca2d56b30a8f1241bb7`
- In-pack source path: `Models/GLB format/character-worker.glb`
- Processed file: `apps/web/public/assets/models/character-worker.glb`
- Rig: Kenney humanoid armature with skinning (skins retained in the processed GLB).
- Animation clips kept (names as authored): `static`, `idle`, `walk`, `sprint`,
  `jump`, `fall`, `crouch`, `sit`, `drive`, `die`, `pick-up`, `emote-yes`,
  `emote-no`, `holding-right`, `holding-left`, `holding-both`,
  `holding-right-shoot`, `holding-left-shoot`, `holding-both-shoot`,
  `attack-melee-right`, `attack-melee-left`, `attack-kick-right`,
  `attack-kick-left`, `interact-right`, `interact-left`, `wheelchair-sit`,
  `wheelchair-look-left`, `wheelchair-look-right`, `wheelchair-move-forward`,
  `wheelchair-move-back`, `wheelchair-move-left`, `wheelchair-move-right`.
- Gaps for #17: the pack has no dedicated typing, reading or leaning-back clip.
  Closest mappings: seated base = `sit` (owns the legs), working/typing =
  `interact-right` on top of it, reviewing/reading = `holding-both` (plus a
  paper prop), waiting = `idle` plus a small lean-back rotation. Variants are the
  one processed character tinted with `BOT_COLORS` plus a primitive accessory.

## Processed outputs

Every file in `apps/web/public/assets/models/` is transformed with glTF-Transform
(dedupe, prune, texture resize to at most 512 px, meshopt compression) by
`pnpm assets:build`. The source packs are not committed; the pipeline records
the archive checksums above. See [`README.md`](./README.md) for details.
