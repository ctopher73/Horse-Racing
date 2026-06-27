# Equibase PDF Import — implementation summary

## What this adds
Client-side (pdfjs-dist, no server, no upload) parsing of an Equibase
Premium Past Performances PDF directly into your existing card/race/horse
model. CSV import, manual entry, scoring, AI, bankroll, and preferences are
all untouched.

## Validation
Tested end-to-end against the real Saturday 6/27 Lone Star Park PDF (79
pages, 12 races, 102 horses) using the **actual** `pdfjs-dist` library
(not a stand-in) running in Node. Result: **12/12 races, 102/102 horses,
94% overall field coverage, zero parse errors.** The ~6% gap is exactly
the maiden-2yo race (breeding-stats table variant with no class/pace/speed
data in the source — correctly left blank per your never-fabricate rule)
plus a couple of legitimate first-time-starters with no prior-race data.

The whole app (existing code + new files) was bundle-compiled with esbuild
with zero errors before delivery.

## New files (drop into your project as-is)
```
src/lib/pdfImport/textExtraction.js       — pdfjs-dist glyph extraction, row clustering
src/lib/pdfImport/sectionDetection.js     — splits the PDF into its 4 report sections
src/lib/pdfImport/raceHeaderParser.js     — track/date/race#/post/surface/distance/purse
src/lib/pdfImport/speedFigureAnalysisParser.js — class rating, pace/speed figs, win%
src/lib/pdfImport/quickStatsParser.js     — ML odds, days since last race, earnings
src/lib/pdfImport/premiumPPParser.js      — program#, name, finishes, workouts, scratches
src/lib/pdfImport/equibaseParser.js        — orchestrates the above + data quality report
src/lib/normalizers/equibaseNormalizer.js — maps parsed data into blankRace()/blankHorse()
src/components/ImportEquibasePDF.jsx       — UI: choose PDF → parse → preview → import
```

## Modified files (merge these changes into your copies)
- **`src/App.jsx`**: added one import line, one new `handleEquibaseImport`
  callback (mirrors `handleApiImport`'s pattern exactly), one new prop on
  `DataTab`, and one new `<ImportEquibasePDF />` render at the top of the
  Data tab (above the existing CSV card, which is unchanged below it).
- **`src/styles.css`**: appended new CSS classes (`.pdf-import-*`) at the
  end of the file. Nothing existing was touched or removed.
- **`package.json`**: added `"pdfjs-dist": "^4.0.379"` to dependencies.

## How the parsing works
1. `textExtraction.js` reads the PDF's real text layer via pdfjs-dist's
   `getTextContent()` and reconstructs proper rows by clustering glyphs
   with y-tolerance and joining them with gap-based word spacing.
2. `sectionDetection.js` finds the 4 report types Equibase concatenates
   into one PDF (Speed Figure Analysis, Premium PP pages, Quick Stats,
   plus Meet Leaders/Horses In Today which aren't used).
3. Each race's data is assembled from **3 sources** (hybrid strategy):
   - Speed Figure Analysis → class rating, pace, speed figures, jockey/
     trainer win%
   - Quick Stats → morning line odds, days since last race, earnings
   - Premium PP pages → program number, horse name, finish history,
     workouts, scratch history (the only place these exist)
4. `equibaseNormalizer.js` maps everything into the exact `blankRace()`/
   `blankHorse()` shapes already in `storage.js` — zero changes needed to
   `scoring.js`, `coach.js`, or any UI component downstream.

## Defaulting rules followed (never fabricated)
Class rating, speed figures, pace, trainer/jockey ROI, early pace rating,
layoff days are left blank when not reliably extracted — confirmed in
testing for the maiden-2yo race format that doesn't carry this data.
`scratched` is intentionally left at its default `false` for every
imported horse: a PP page's "Scratch(es):" line records *historical*
scratches from past entries, never a same-day scratch, so it must never be
used to flip today's scratched flag.

## Testing performed
- Real-data validation of every regex/pattern against the actual PDF
  before writing production code (not assumption-based).
- Full pipeline run against real `pdfjs-dist` (not just a Python
  stand-in) in Node, iterating through several real layout variants
  found in the document (claiming races, stakes/turf races, maiden races)
  until all 12 races and 102 horses extracted correctly.
- Full esbuild bundle compile of the entire app (existing + new code)
  with zero errors.

## What you should still test in the browser
- Upload both the Friday 6/26 (8-race) and Saturday 6/27 (12-race) PDFs
  through the actual UI to confirm the browser's pdfjs-dist worker setup
  (`pdfjs-dist/build/pdf.worker.min.mjs?url`) resolves correctly under
  Vite — this was validated with Node's pdfjs-dist build, not Vite's
  bundler, so it's worth a first real click-through.
- Confirm the scoring tab, AI tab, and bankroll tab all render normally
  for an imported card (they should, since the shape matches CSV import
  exactly, but worth a visual check).
- Try importing on top of an existing card with data already in it, to
  see the track/date overwrite behavior feels right.
