// ============================================================================
// SPEED FIGURE ANALYSIS PARSER — one clean row per horse, all races, on
// pages 0-2 of a standard Equibase Premium PP export. This is the primary
// source for classRating, pace figures, speed figures, and jockey/trainer
// win% per the hybrid-source design (see project notes): the PP header
// block is genuinely multi-column with no shared baseline, so these stats
// are read from here instead of fighting that layout.
//
// Row shape (validated against real extraction):
//   "<pgm> <post> (<winPct>%) <Horse Name> <classRating> <lastPace>
//    <avgLast3Pace> <highestLifetimePace> <lastSpeed> <avgLast3Speed>
//    <highestLifetimeSpeed> <Jockey> / <Trainer> <jockeyPct>% <trainerPct>%
//    <comboPct>%"
//
// A second table variant exists for first-time-starter 2yo maiden races
// (sire/dam pace averages and stud fees instead of class/pace/speed); this
// parser intentionally does NOT match that variant. Per the project's
// explicit defaulting rule — never fabricate handicapping-derived fields —
// horses on that variant simply get blank classRating/speedFigs/pace
// fields, which is correct, not a gap to patch.
// ============================================================================

// Race boundary marker: every race's table is preceded by a row starting
// with "Exacta" (the wagering-type header line). Validated against real
// pdfjs-dist extraction: the large race-number graphic above each table is
// a vector drawing, not a text glyph, so it never appears in extracted
// text at all here (unlike the PP pages, where the race number IS a text
// glyph — see sectionDetection.js's extractRaceNumber). Race numbers are
// therefore tracked sequentially (1, 2, 3, ...) as each "Exacta" line is
// encountered, which is reliable since Equibase always presents SFA
// sections in race-number order.
const RACE_BOUNDARY_RE = /^Exacta/;
const SFA_ROW_RE =
  /^(\d{1,2})\s+(\d{1,2})\s+\((\d{1,3})%\)\s+(.+?)\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+(.+?)\s*\/\s*(.+?)\s+(\d{1,3})%\s+(\d{1,3})%\s+(\d{1,3})%$/;

/**
 * @param {{pageIndex: number, rows: string[]}[]} pages - only the pages
 *   classified as Speed Figure Analysis
 * @returns {Map<string, object>} key "<raceNumber>:<programNumber>" -> stats
 */
export function parseSpeedFigureAnalysis(pages) {
  const results = new Map();
  let currentRace = 0;

  for (const { rows } of pages) {
    for (const row of rows) {
      if (RACE_BOUNDARY_RE.test(row)) {
        currentRace += 1;
        continue;
      }
      if (currentRace === 0) continue;

      const m = row.match(SFA_ROW_RE);
      if (!m) continue; // breeding-stats table variant, or a non-data row

      const [
        , pgm, , winPct, name,
        classRating, lastPace, avgLast3Pace, highestLifetimePace,
        lastSpeed, avgLast3Speed, highestLifetimeSpeed,
        jockey, trainer, jockeyPct, trainerPct, comboPct,
      ] = m;

      const key = `${currentRace}:${pgm}`;
      results.set(key, {
        raceNumber: currentRace,
        programNumber: pgm,
        name: name.trim(),
        winPctAtThisOdds: winPct,
        classRating,
        lastPace,
        avgLast3Pace,
        highestLifetimePace,
        lastSpeed,
        avgLast3Speed,
        highestLifetimeSpeed,
        jockey: jockey.trim(),
        trainer: trainer.trim(),
        jockeyWinPct: jockeyPct,
        trainerWinPct: trainerPct,
        comboWinPct: comboPct,
      });
    }
  }

  return results;
}
