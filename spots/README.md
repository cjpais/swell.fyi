# Surf spots

One Markdown file per spot. This is the only place to edit a spot: `bun run spots` checks every file and writes `src/data/spots.json`, which the site, the scripts and the swell-data Worker all read. `bun run build` and `bun run deploy:data` run the check first, so a broken file stops the build with the file and the problem.

## Adding a spot

Copy a file, name it with the spot's id (lowercase, hyphens: `wushi-north.md`), fill in the front matter, write a few lines about it, then run `bun run spots`. The new spot gets its forecast and page data once the swell-data Worker is redeployed (`bun run deploy:data`).

## Front matter

Only what the site and the forecast use directly:

```yaml
---
name: Beibin
nameZh: 北濱
region: Hualien              # North coast, Yilan, Hualien, Taitung, Kenting / Pingtung, West & islands
location: [23.9777, 121.6208] # [lat, lon] of the break itself, where the waves break
faces: 158                   # the direction the break faces, degrees clockwise from north
swell:
  best: [140, 175]           # swell directions it likes best: [from, to], clockwise
  works: [128, 215]          # the wider range it still works in; best must sit inside it
cwaPoint: I06100             # its point in CWA's recreation sea forecast (M-B0078-001)
buoys: [46699A, C4T01]       # CWA stations, nearest or most relevant first
---
```

Bearings are where the swell comes **from**. A range runs clockwise, so `[330, 30]` is north-northwest round to north-northeast.

The site uses them like this:

- `faces`: wind within about 45° of straight offshore is offshore, out to about 80° cross-offshore, then cross-shore and onshore. It colours every wind bar and chip.
- `swell`: the shaded window on the compass, and whether each swell is coming from its best directions, ones it works in, or is blocked.
- The wave models are read about 5 km out along `faces`. For an odd case (a headland straight out, an island spot), give `model: [lat, lon]` to choose the point yourself.

## The written part

Everything else goes in prose below the front matter: how it breaks, swell that wraps in when it's big, shelter from the wind, tide, size, hazards. It's shown on the spot page as it is. Notes for editors, like where a pin came from or what still needs checking, go in YAML comments (`# ...`) in the front matter, which nothing reads or shows.
