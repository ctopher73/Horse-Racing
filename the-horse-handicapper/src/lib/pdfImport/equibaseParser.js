// ============================================================================
// EQUIBASE PDF IMPORTER — top-level orchestration.
//
// Pipeline: raw PDF bytes -> pdfjs-dist text extraction -> section
// classification -> per-source parsing (Speed Figure Analysis, Quick
// Stats, Premium PP) -> normalization into blankRace()/blankHorse() shape
// -> data quality report.
//
// This is the only module the UI component needs to call.
// ============================================================================

import { extractPdfRows } from "./textExtraction.js";
import { classifyPages, groupPPPagesByRace } from "./sectionDetection.js";
import { parseRaceHeader } from "./raceHeaderParser.js";
import { parseSpeedFigureAnalysis } from "./speedFigureAnalysisParser.js";
import { parseQuickStats } from "./quickStatsParser.js";
import { parsePPRace } from "./premiumPPParser.js";
import { normalizeCard } from "../normalizers/equibaseNormalizer.js";

const TRACK_NAME_RE = /Speed Figure Analysis for\s+(.+)$/;

/**
 * @param {ArrayBuffer} arrayBuffer - raw bytes of the uploaded PDF
 * @param {object} pdfjsLib - the pdfjs-dist module
 * @returns {Promise<{
 *   card: { track: string, date: string, races: object[] },
 *   qualityReport: object,
 *   errors: string[],
 * }>}
 */
export async function importEquibasePdf(arrayBuffer, pdfjsLib) {
  const errors = [];
  const pages = await extractPdfRows(arrayBuffer, pdfjsLib);
  const pageRowsByIndex = new Map(pages.map((p) => [p.pageIndex, p.rows]));

  const classified = classifyPages(pages);

  if (!classified.ppOpenerPages.length) {
    errors.push(
      "No race pages were recognized in this PDF. Make sure you uploaded an Equibase Premium Past Performances export."
    );
    return { card: null, qualityReport: null, errors };
  }

  // Track name: read once from the Speed Figure Analysis banner.
  let trackName = "";
  for (const pageIndex of classified.speedFigureAnalysisPages) {
    const rows = pageRowsByIndex.get(pageIndex) || [];
    for (const row of rows) {
      const m = row.match(TRACK_NAME_RE);
      if (m) {
        trackName = m[1].trim();
        break;
      }
    }
    if (trackName) break;
  }
  if (!trackName) {
    errors.push("Could not determine the track name from this PDF; races were imported without it.");
  }

  const sfaPages = classified.speedFigureAnalysisPages.map((i) => ({ pageIndex: i, rows: pageRowsByIndex.get(i) || [] }));
  const qsPages = classified.quickStatsPages.map((i) => ({ pageIndex: i, rows: pageRowsByIndex.get(i) || [] }));
  const sfaByKey = parseSpeedFigureAnalysis(sfaPages);
  const qsByKey = parseQuickStats(qsPages);

  const raceToPages = groupPPPagesByRace(pages, classified);
  const parsedRaces = [];

  for (const [raceNumber, pageIndexes] of raceToPages) {
    const racePages = pageIndexes.map((i) => ({
      pageIndex: i,
      rows: pageRowsByIndex.get(i) || [],
    }));
    const openerPage = racePages[0];
    const raceHeader = parseRaceHeader(openerPage.rows, trackName);

    if (raceHeader.raceNumber == null) {
      errors.push(`Could not read the race number for one race; it may be missing from the import.`);
      continue;
    }

    const ppHorses = parsePPRace(racePages);
    if (!ppHorses.length) {
      errors.push(`Race ${raceNumber}: no horses could be extracted from the PP pages.`);
    }

    parsedRaces.push({ raceHeader, ppHorses, sfaByKey, qsByKey });
  }

  const races = normalizeCard(parsedRaces);
  const qualityReport = buildQualityReport(races, errors);

  // Card date: every race carries the same date; take it from the first
  // race that has one.
  const cardDate = races.find((r) => r.date)?.date || parsedRaces.find((p) => p.raceHeader.date)?.raceHeader.date || "";

  return {
    card: { track: trackName, date: cardDate, races },
    qualityReport,
    errors,
  };
}

// ---------------------------------------------------------------------------
// DATA QUALITY REPORT
// ---------------------------------------------------------------------------
const TRACKED_HORSE_FIELDS = [
  "programNumber",
  "name",
  "jockey",
  "trainer",
  "mlOdds",
  "classRating",
  "speedFigs",
  "last3Finishes",
  "trainerWinPct",
  "jockeyWinPct",
  "daysSinceLastRace",
  "workouts",
];

function buildQualityReport(races, errors) {
  let totalHorses = 0;
  const fieldFilled = {};
  const fieldTotal = {};
  TRACKED_HORSE_FIELDS.forEach((f) => {
    fieldFilled[f] = 0;
    fieldTotal[f] = 0;
  });

  races.forEach((race) => {
    race.horses.forEach((horse) => {
      totalHorses += 1;
      TRACKED_HORSE_FIELDS.forEach((f) => {
        fieldTotal[f] += 1;
        if (horse[f] !== "" && horse[f] != null) fieldFilled[f] += 1;
      });
    });
  });

  const fieldCoverage = TRACKED_HORSE_FIELDS.map((f) => ({
    field: f,
    filled: fieldFilled[f],
    total: fieldTotal[f],
    pct: fieldTotal[f] ? Math.round((fieldFilled[f] / fieldTotal[f]) * 100) : 0,
  }));

  const overallFilled = fieldCoverage.reduce((sum, f) => sum + f.filled, 0);
  const overallTotal = fieldCoverage.reduce((sum, f) => sum + f.total, 0);
  const overallConfidencePct = overallTotal ? Math.round((overallFilled / overallTotal) * 100) : 0;

  return {
    racesImported: races.length,
    horsesImported: totalHorses,
    fieldCoverage,
    overallConfidencePct,
    errors,
  };
}
