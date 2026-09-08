# Station link logos

The footer's "This station on the weather networks" section
([`web/src/components/StationLinks.astro`](../web/src/components/StationLinks.astro),
registry in [`web/src/lib/stations.ts`](../web/src/lib/stations.ts)) shows each
service's own logo. The files live in `web/public/stations/` and are **vendored,
not hotlinked** — no third-party request when the page loads, and nothing breaks
when a service reshuffles its asset paths.

All four are normalised to a **96 px square PNG** (3x the 32 px tile, so they stay
sharp on retina) with `magick ... -resize 96x96 -strip`.

| File | Source | Notes |
|---|---|---|
| `wunderground.png` | `wunderground.com/favicon.ico`, 64 px frame | The `.ico` holds 16/32/48/64; frame `[3]` is the only usable one. Black square background is part of the mark. |
| `windy.png` | `img.windy.com/albums/icons/logo-full.png?w=256` | The one service that ships a clean high-res icon. |
| `noaa.png` | [`Noaa-logo-rgb-2022.svg`](https://commons.wikimedia.org/wiki/File:Noaa-logo-rgb-2022.svg) on Wikimedia Commons | Flattened onto white. US Government work, public domain. |
| `wowbe.png` | `wow.meteo.be/wp-content/uploads/2017/10/cropped-wowbe_sq_icn-180x180.png` (their apple-touch-icon) | Flattened onto white. |

## Why these sources

The obvious route — grab each site's `favicon.ico` — only works for two of them:

- **aprs.fi** (where the CWOP link points) ships a single **16x16** favicon, and
  it's a **red car**, from APRS's vehicle-tracking side. Wrong subject, and
  unusable at 32 px. CWOP itself has no logo, so the tile uses **NOAA's**, who
  run the programme.
- **wunderground.com** has no `apple-touch-icon`; the site's own
  `wu-knockout.svg` is pure white on transparent (`fill="#FFFFFF"`), so it
  vanishes on a light background. The 64 px favicon frame is the only
  self-contained version.
- **wow.meteo.be**'s mark is a pale multi-colour pin cluster that stays busy at
  32 px. It's kept anyway because it is genuinely their logo — RMI's own `RMI`
  wordmark reads far better small, but belongs to the parent institute, not to
  WOW-BE.

## Theme handling

Every logo keeps its own opaque background (WU black, Windy red, NOAA and WOW-BE
white), so the tiles read correctly in **both** light and dark mode with no
per-theme swap. A `ring-1 ring-border` keeps the white ones from bleeding into
the dark surface.

## Trademark

These are third-party marks, used to identify the linked service — the station's
own page on each network. That's nominative use, not a claim of affiliation or
endorsement. If any service objects, swap that entry's `logo` for a neutral
[Lucide](https://lucide.dev) glyph; git history has the all-Lucide version the
section shipped with first.
