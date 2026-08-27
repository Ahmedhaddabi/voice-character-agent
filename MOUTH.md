# The mouth: where it stands

## Current state

The dark overlay is gone. It was a flat patch drawn on her face and it looked
like one.

What runs now is the `MouthOpen` shape key alone, driven by audio amplitude.
Her lips and chin move when she speaks. No teeth, no tongue, no visible
opening — but nothing looks broken, which is more than the overlay managed.
That is shippable today.

## Why her mouth cannot open

Her head is a sealed pouch. There is no mouth hole anywhere on the mesh: the
lips are a crease in a continuous surface, and the head is hollow with no
interior geometry.

I verified this two ways. There is no boundary edge loop at the mouth — the
scattered boundary edges on this mesh are generator noise, not a deliberate
cut. And the `MouthDark` plane that shipped inside your file has never been
visible once, because the face is in front of it.

That is why Blender fought you. The shape key works fine and drags 942
vertices of lip and chin downward. But stretching a crease in a sealed surface
never produces an opening, so there is nothing for teeth or a tongue to be seen
through. No amount of shape-key work changes that. The mesh has to be cut.

## Your sprite sheet

Cut up and included, in `public/mouth/`. Thirteen speech shapes, seven emotion
mouths, transparent PNGs with teeth and tongue already drawn in.

`src/lib/visemeAnalyser.js` picks which one to show from live audio, using
formant band ratios rather than raw amplitude — amplitude cannot tell "ee" from
"oh", since both can be loud.

Try it before building on it. Run the dev server and open
`http://localhost:5173/viseme-test.html`, then say "ooh", "eee", "ssss", "mmm".
Ten seconds tells you whether the approach is worth committing to.

These are not wired into the 3D character, deliberately. They are flat cartoon
vectors with hard outlines and their own skin tone; on her rendered face they
read as a sticker. They belong on a 2D character.

## The three ways forward

**Ship as is.** Shape key only. Lips move, no opening. Least work, and it does
not look broken.

**Go 2D.** Get a character in the flat style these sprites were drawn for. The
mouth problem disappears by construction — you show the O sprite and you get an
O mouth. Nothing in the voice pipeline changes: same token service, same
session, same controller and gesture tools. Only the renderer swaps.

**Rebuild the head in VRoid Studio.** Free, a few hours, and you get a real
mouth cavity, teeth, tongue, a full viseme set, blinking and spring bones,
already rigged. The app already loads VRM, so it would be a drop-in. The cost
is that she becomes a VRoid-styled version of your design rather than this
exact mesh.

Cutting a mouth into the current model by hand in Blender is possible — knife
along the lip crease, delete the interior faces, extrude the edge loop inward
twice, cap the back, add teeth and tongue, weight to the `Head` bone, add the
new vertices to `MouthOpen` — but it is an afternoon of real 3D work and you
have already spent longer than either alternative would take.
