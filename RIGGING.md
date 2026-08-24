# Getting her moving

## What you uploaded

| | Original | Now in `public/character.glb` |
|---|---|---|
| File size | 103 MB | 652 KB |
| Triangles | 1,000,000 | 55,564 |
| Vertices | 2,997,206 (unwelded) | 27,744 |
| Figures | 2 duplicate copies | 1 |
| Scale | 2 arbitrary units | 1.6 m, feet at origin |
| Skeleton | none | none |
| Blendshapes | none | none |
| Textures | none | none |

Three things were wrong beyond the polygon count. The export contained two
complete copies of her side by side, so half the file was waste. Every vertex
was unwelded — 6 copies of each position, because per-face normals split them.
And there are no textures at all: the mesh has valid UVs but zero images, so
the colours you saw in the generator preview did not make it into the file.

She loads and stands on screen now. She breathes and sways. Her mouth and
hands cannot move yet, because there are no joints to move.

## What's left, in order

**1. Get the texture.** Re-export from the generator with textures included,
or the app shows her in flat beige. The UVs survived decimation, so a texture
image will map correctly if you can obtain one. This is the step most likely
to need the PRO export.

**2. Auto-rig at Mixamo.** Upload `character.glb`, place the chin, wrist,
elbow, knee and groin markers, download as FBX. Her arms hang close to her
body, which is harder for auto-rigging than a T-pose — if the arms bind to the
torso, rotate them outward 30–40° in Blender first and retry.

Expect the dupatta to skin to the spine and move as one sheet. That looks
acceptable in motion and is fixable later with spring bones.

**3. Grab gesture clips** while you're at Mixamo — waving, talking, thinking,
idle. Downloading these against the same rig is what fills `POSES` with real
animation instead of the procedural approximations in `stage.js`.

**4. Add face blendshapes in Blender.** This is the manual part, a couple of
hours. Shape keys for `aa`, `ih`, `ou`, `ee`, `oh` and `blink`. Check first
whether her mouth is a sealed surface — generated meshes usually have no mouth
interior, so you may need to model a simple cavity before the visemes read.

**5. Export VRM** with the VRM Add-on for Blender, mapping Mixamo bones to the
VRM humanoid slots and shape keys to the expression presets. Save as
`public/character.vrm` and the app switches to the full rig automatically.

## Shortcut if step 4 stalls

After step 2 you have a skeleton with a head bone. Rotating a jaw or head bone
by `controller.mouth` gives readable speech on a stylised character and takes
five minutes, versus a couple of hours for real visemes. Ship that, upgrade
later — nothing else in the pipeline changes.
