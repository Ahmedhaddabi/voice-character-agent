# The rigged model

The file you uploaded was already rigged, textured and given a mouth shape key
by whoever built it. That is a much better starting point than the raw
generator export, and it made the mouth-overlay workaround unnecessary — it has
been removed.

## What was in it

| | Uploaded | Now in `public/character.glb` |
|---|---|---|
| File size | 27 MB | 3.6 MB |
| Triangles | 525,093 | 63,083 |
| Textures | 2 × 8192px JPEG | 2 × 2048px JPEG |
| Skeleton | 19 bones | preserved |
| Mouth shape key | `MouthOpen` | preserved |
| Animations | 2 clips | preserved |

The textures were the urgent problem, more than the triangles. An 8192×8192
image decodes to roughly 268 MB of GPU memory, and there were two of them —
over half a gigabyte before a single triangle is drawn. That alone would crash
or freeze most phones. At 2048px they cost about 16 MB each and look identical
at conversation distance.

## What the rig gives you

`MouthOpen` moves 961 vertices of the lower lip down and slightly forward.
It is a jaw drop, not a viseme set, which is exactly what an amplitude signal
can drive well. The app now sets its influence directly from `controller.mouth`
every frame.

The skeleton is Blender-named — `Head`, `Spine`, `Chest`, `UpperArm.L/R`,
`ForeArm.L/R`, `Hand.L/R` — and the gesture poses drive those bones. There is
also a small separate `MouthDark` mesh forming the mouth interior, which is why
an open mouth reads as a cavity rather than a hole.

Two baked clips came along: a 2-second right-arm wave, and a canned talking
loop for the mouth. The app ignores both, since your audio drives the mouth
far better than a fixed loop. The wave is worth wiring up later if you want a
real animation instead of the procedural one.

## One thing to know about the bones

These bones have non-identity rest rotations — `UpperArm.R` rests at a
quaternion of roughly (-0.45, -0.45, 0.29, 0.71), not identity. Poses are
therefore applied as offsets multiplied onto the rest rotation, not set
absolutely. Setting them absolutely is what makes an imported rig collapse into
a twisted heap, and it is the single most common way this goes wrong.

If you later swap in a Mixamo rig, add its bone names to `BONE_NAMES` in
`stage.js` — a few aliases are already there.

## Cost of the decimation

Dropping to 63k triangles cut the mouth shape key from 961 affected vertices to
178, because the simplifier does not know those vertices matter. The
displacement magnitude survives, so the mouth still opens as far; the lip edge
is just coarser. If her mouth looks blocky when open, re-run the decimation at
a higher ratio — 0.20 gives 105k triangles and 287 mouth vertices, which is
still fine on desktop but heavier on phones.
