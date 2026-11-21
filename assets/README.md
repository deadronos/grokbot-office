# Assets

Processed, committed 3D assets for the office scene live in
`apps/web/public/assets/models/` and are served as static files by Vite (they
are never imported into the JS bundle).

They are generated from CC0 Kenney packs; authors, licences and source URLs are
recorded in [`LICENSES.md`](./LICENSES.md).

## Rebuilding

```sh
pnpm assets:build
```

The script (`packages/assets/src/build.mjs`):

1. Downloads the pinned `furniture-kit` and `mini-characters` archives from
   kenney.nl into the gitignored `assets/cache/` and verifies their SHA-256.
2. Selects five furniture models plus one rigged character.
3. Runs glTF-Transform: `dedup` -> `prune` -> `textureCompress` (PNG, max
   512 px) -> `meshopt` compression, writing one `.glb` per model to
   `apps/web/public/assets/models/`.

The packs only need re-downloading when the cache is empty; the committed
outputs mean CI and fresh clones need neither network nor the pipeline.

## Compression and #17

Outputs use `EXT_meshopt_compression` plus `KHR_mesh_quantization`. In the web
app, load them with three.js `GLTFLoader` and a meshopt decoder, for example
drei's `useGLTF(url, true)` followed by
`gltfLoader.setMeshoptDecoder(MeshoptDecoder)`. The character
(`character-worker.glb`) keeps its Kenney humanoid rig and all animation clips;
see `LICENSES.md` for the clip names and the gaps (no typing/reading clips).
