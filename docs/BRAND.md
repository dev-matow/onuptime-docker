# The mark

Vigil's logo is a pixel eye. One drawing, monochrome, on a 25 x 11 grid
of whole pixels: white on dark surfaces, black on light ones, and never
paired with lettering inside the same file. The wordmark beside it in the
header is text, and stays text.

![The three frames](brand/vigil-mark.svg)

## Where it comes from

`scripts/brand-mark.mjs` and nowhere else. The grid is written there as
runs of ink per row; everything that carries a logo is generated from it:

| Surface                                   | What it gets                           |
| ----------------------------------------- | -------------------------------------- |
| `src/lib/brand-mark.ts`                   | the three frame paths, for the app     |
| `landing/**/*.html`                       | the inline mark in every `.brand` link |
| `landing/favicon.svg`, `src/app/icon.svg` | the open frame on a dark tile          |
| `docs/brand/`                             | standalone assets, white and black     |
| the two social card sources               | the open frame, sized                  |

```bash
npm run brand         # redraw every surface
npm run brand:check   # a required CI job
```

The check is what makes this a single source rather than a claim about
one. It fails when a surface disagrees with the grid, when the retired
pulse mark reappears anywhere, and when a brand link is handed a picture
of the logo instead of the logo. Before this existed the mark was a
stroked polyline pasted into twenty-eight places, and changing it meant
finding all of them.

The two PNGs are rendered by hand from committed HTML, and each file
carries the command:

- `scripts/brand/og-card.html` renders `landing/assets/og-card.png`
- `.github/social-preview.html` renders `.github/social-preview.png`

## The blink

The eye blinks. Rarely, and by swapping whole frames:

    open -> half -> closed -> half -> open        60ms + 70ms + 50ms

once every 7 to 15 seconds, twice in a row a quarter of the time.
Nothing interpolates, nothing scales, nothing fades, and the mark never
moves a subpixel: every frame shares the viewBox, the centre and the two
corner pixels of the eye, so a blink cannot read as the logo shifting.

It is paused while the document is hidden, and it does not run at all
under `prefers-reduced-motion: reduce`, where the open frame is what
renders. Both are asserted in `e2e/brand.spec.ts` against a real page,
because the way this feature fails is silently.

There is at most **one** blinking mark on a page: the site header, and
the application's own brand mark. The footer's copy, the favicons, the
demo export, screenshots and printed reports all take the static open
frame. Two eyes blinking on their own schedules reads as a rendering
fault rather than as a detail.

## What is not Vigil's to brand

Status pages and client reports carry the **customer's** logo, name and
colour. Vigil's mark appears on a status page only in the "Powered by
Vigil" footer, and only when that customer left branding switched on. It
appears on a report never. A white-label surface with our logo on it is
a bug, not a marketing opportunity.
