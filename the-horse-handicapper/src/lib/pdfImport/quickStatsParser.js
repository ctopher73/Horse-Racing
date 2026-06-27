// ============================================================================
// QUICK STATS PARSER — one clean row per horse, all races, on the Quick
// Stats pages of a standard Equibase Premium PP export. This is the primary
// source for morning-line odds and days-since-last-race per the
// hybrid-source design, plus supplementary win%/earnings context.
//
// Row shape (validated against real extraction):
//   "<pgm> <Horse Name> <ML odds> <daysUnraced|--> <Jockey> / <Trainer>
//    <3 or 4 win% tokens> <optional: $earnings time year $price>"
//
// The win% column count varies (3 vs 4) depending on whether the horse has
// raced at this distance before — "In The Money %" simply doesn't print
// when there's no distance history. This is read positionally from the
// end: last token is always In-The-Money% when 4 are present, absent when
// 3 are present.
// ============================================================================

// Race boundary marker: every race's table is preceded by a row starting
// with "Exacta" — validated to appear exactly once per race (12 total
// across the 3 Quick Stats pages), with no race number embedded in that
// row in real pdfjs-dist extraction (the big race-number graphic above
// each table is a vector drawing, not a text glyph). Race numbers are
// tracked sequentially as each "Exacta" line is encountered.
const RACE_BOUNDARY_RE = /^Exacta/;
const QS_ROW_RE =
  /^(\d{1,2})\s+(.+?)\s+(\d+-\d+|--)\s+(\d+|--)\s+(.+?)\s*\/\s*(.+?)\s+((?:\d{1,3}%\s*)+)(.*)$/;

/**
 * @param {{pageIndex: number, rows: string[]}[]} pages - only the pages
 *   classified as Quick Stats
 * @returns {Map<string, object>} key "<raceNumber>:<programNumber>" -> stats
 */
export function parseQuickStats(pages) {
  const results = new Map();
  let currentRace = 0;

  for (const { rows } of pages) {
    for (const row of rows) {
      if (RACE_BOUNDARY_RE.test(row)) {
        currentRace += 1;
        continue;
      }
      if (currentRace === 0) continue;

      const m = row.match(QS_ROW_RE);
      if (!m) continue;

      const [, pgm, name, mlOdds, daysUnraced, jockey, trainer, pctBlob, trailing] = m;
      const pcts = pctBlob.trim().split(/\s+/).map((p) => p.replace("%", ""));
      // 4 tokens: [lifetimePct, atTrackPct, atDistancePct, inTheMoneyPct]
      // 3 tokens: [lifetimePct, atTrackPct, atDistancePct] (no ITM data)
      const [lifetimeWinPct, atTrackWinPct, atDistanceWinPct, inTheMoneyPct] =
        pcts.length >= 4 ? pcts : [...pcts, ""];

      const trailingMatch = trailing
        .trim()
        .match(/^\$([\d,]+)?\s*([\d:.]+)?\s*(\d{4})?\s*\$?([\d,]+)?$/);

      const key = `${currentRace}:${pgm}`;
      results.set(key, {
        raceNumber: currentRace,
        programNumber: pgm,
        name: name.trim(),
        mlOdds: mlOdds === "--" ? "" : mlOdds,
        daysSinceLastRace: daysUnraced === "--" ? "" : daysUnraced,
        jockey: jockey.trim(),
        trainer: trainer.trim(),
        lifetimeWinPct,
        atTrackWinPct,
        atDistanceWinPct,
        inTheMoneyPct,
        lifetimeEarnings: trailingMatch ? trailingMatch[1] || "" : "",
        fastestTimeAtDistance: trailingMatch ? trailingMatch[2] || "" : "",
      });
    }
  }

  return results;
}
