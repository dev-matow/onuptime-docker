# The mark

Vigil's logo is two curved blades around a narrow waist, one closed
vector path in an 80 x 128 box. Monochrome: graphite on light surfaces,
white on dark ones, and never paired with lettering inside the same
file. The wordmark beside it is text, widely tracked, and stays text.

![The mark](brand/vigil-mark-dark.svg)

The drawing has two optical cuts. `display` is the mark as the identity
board draws it: a tight waist and a fine aperture, for surfaces with
room. `small` widens the aperture and thickens the stems, because below
about 32px the display cut's counter seals into a blob; it is what the
navbars, footers, favicons and app chrome carry. Same rule every text
face in this repository follows; the mark gets it too.

## Where it comes from

`scripts/brand-mark.mjs` and nowhere else. The left blade is written
there as one set of numbers; the right blade is derived by mirroring,
and everything that carries a logo is generated from both:

| Surface                                   | What it gets                           |
| ----------------------------------------- | -------------------------------------- |
| `src/lib/brand-mark.ts`                   | the path, for the application          |
| `landing/**/*.html`                       | the inline mark in every `.brand` link |
| `landing/favicon.svg`, `src/app/icon.svg` | the mark centred on an icon tile       |
| `docs/brand/`                             | standalone assets, white and graphite  |
| the social card sources                   | the mark, sized, between markers       |

```bash
npm run brand         # redraw every surface
npm run brand:check   # a required CI job
```

The check is what makes this a single source rather than a claim about
one. It fails when a surface disagrees with the geometry, when a retired
mark reappears anywhere (the stroked pulse polylines, the pixel eye's
subpaths, or the eye's blink plumbing), and when a brand link is handed
a picture of the logo instead of the logo. `e2e/brand.spec.ts` asserts
the same facts against a real rendered page.

The raster cards are rendered from committed HTML, and each file
carries the command:

- `scripts/brand/og-card.html` renders `landing/assets/og-card.png`
- `.github/social-preview.html` renders `.github/social-preview.png`
- `scripts/core-overlay/social-preview.html` renders the Core repo's card

## The mark is still

Its predecessor, the pixel eye, blinked. The blink retired with it on
2026-08-17: the blades are a quiet form, and animating them would be
decoration rather than behaviour. There is no frame swapping, no
scheduler and no motion preference to honour, because nothing moves.

## What is not Vigil's to brand

Status pages and client reports carry the **customer's** logo, name and
colour. Vigil's mark appears on a status page only in the "Powered by
Vigil" footer, and only when that customer left branding switched on. It
appears on a report never. A white-label surface with our logo on it is
a bug, not a marketing opportunity.
