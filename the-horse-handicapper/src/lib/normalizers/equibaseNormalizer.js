// ============================================================================
// EQUIBASE NORMALIZER — converts parsed PDF data into the exact race/horse
// shapes the rest of the app already understands (blankRace()/blankHorse()
// from storage.js). The scoring engine, AI coach, and every UI component
// require zero changes: once a card's races match this shape, everything
// downstream just works, exactly as with CSV import or manual entry.
//
// DEFAULTING RULES (per project spec — never fabricate):
//   - speedFigs, classRating, trainerWinPct/jockeyWinPct/comboWinPct,
//     trainerROI/jockeyROI/comboROI, earlyPaceRating, workouts, layoffDays:
//     left blank ("") if not reliably extracted. Never guessed.
//   - scratched defaults false (set true only if a Scratch(es) line for
//     today's date/race was found — see note below).
//   - surfaceFit / distanceFit / workoutQuality default "neutral".
//   - runningStyle defaults "E" (the existing blankHorse() default,
//     left untouched since the PP pages' encoded running-style markers
//     aren't reliably extractable without risking a wrong guess).
//   - oddsHistory defaults [] (handled by blankHorse() already).
// ============================================================================

import { blankRace, blankHorse } from "../storage.js";

/**
 * @param {object} raceHeader - output of parseRaceHeader()
 * @param {Array} ppHorses - output of parsePPRace() for this race
 * @param {Map} sfaByKey - output of parseSpeedFigureAnalysis()
 * @param {Map} qsByKey - output of parseQuickStats()
 * @returns {object} a race object matching blankRace() shape, fully populated
 */
export function normalizeRace(raceHeader, ppHorses, sfaByKey, qsByKey) {
  const race = blankRace(raceHeader.raceNumber || 1);
  race.postTime = raceHeader.postTime || "";
  race.surface = raceHeader.surface || "Dirt";
  race.distance = raceHeader.distance || "";
  race.raceType = raceHeader.raceType || "";
  race.purse = raceHeader.purse || "";
  race.fieldSizeNote = ppHorses.length ? `${ppHorses.length} horses` : "";

  race.horses = ppHorses.map((ppHorse) =>
    normalizeHorse(ppHorse, raceHeader.raceNumber, sfaByKey, qsByKey)
  );

  return race;
}

function normalizeHorse(ppHorse, raceNumber, sfaByKey, qsByKey) {
  const horse = blankHorse();
  const key = `${raceNumber}:${ppHorse.programNumber}`;
  const sfa = sfaByKey.get(key);
  const qs = qsByKey.get(key);

  horse.programNumber = ppHorse.programNumber || "";
  horse.name = ppHorse.name || "";
  horse.dataSource = "api"; // imported, not hand-typed — matches the
                            // existing dataSource convention used for
                            // future live-provider integrations

  // --- From Quick Stats (primary source for these fields) -----------------
  if (qs) {
    horse.mlOdds = qs.mlOdds || "";
    horse.daysSinceLastRace = qs.daysSinceLastRace || "";
    if (!ppHorse.jockey && qs.jockey) horse.jockey = qs.jockey;
    if (!ppHorse.trainer && qs.trainer) horse.trainer = qs.trainer;
  }

  // --- From Speed Figure Analysis (primary source for these fields) -------
  if (sfa) {
    horse.classRating = sfa.classRating || "";
    // speedFigs: most-recent-first per the existing CSV convention
    // ("84,81,86" most recent first) — Speed Figure Analysis's "Last",
    // "Average Last 3" don't give us 3 discrete figures, only last + a
    // rolling average, so we store what we reliably have rather than
    // fabricating a 3-figure series: last figure only, comma-separated
    // with nothing invented.
    horse.speedFigs = sfa.lastSpeed || "";
    horse.trainerWinPct = sfa.trainerWinPct || "";
    horse.jockeyWinPct = sfa.jockeyWinPct || "";
    horse.trainerJockeyComboWinPct = sfa.comboWinPct || "";
    if (!horse.jockey && sfa.jockey) horse.jockey = sfa.jockey;
    if (!horse.trainer && sfa.trainer) horse.trainer = sfa.trainer;
  }

  // --- From Premium PP pages (the only source for these fields) -----------
  if (ppHorse.finishes && ppHorse.finishes.length) {
    // last3Finishes convention (per storage.js / CSV import): most-recent
    // first, dash-separated, e.g. "1-3-2". ppHorse.finishes is already in
    // document order (most recent race listed first on the PP page).
    horse.last3Finishes = ppHorse.finishes.slice(0, 3).join("-");
  }
  horse.workouts = (ppHorse.workouts || "").replace(/[\u0000-\u001f\u0080-\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  horse.notes = ppHorse.scratches
    ? `Scratch history: ${ppHorse.scratches.replace(/[\u0000-\u001f\u0080-\u00a0]/g, " ").replace(/\s+/g, " ").trim()}`
    : "";

  // scratched: per the defaulting rule, this stays false unless we have
  // explicit evidence the horse is out of *this* card's *this* race — a
  // Scratch(es) line on the PP page records historical scratches from past
  // entries, not a scratch from today's race, so it must never be used to
  // set today's scratched flag. Equibase signals a same-day scratch with a
  // distinct marker on the race card itself that this import does not yet
  // parse, so scratched is intentionally left at its default (false) for
  // every imported horse — the person can mark a late scratch by hand,
  // exactly as they would with CSV import or manual entry today.

  return horse;
}

/**
 * Top-level entry point: combines every race's normalized data into the
 * races array the rest of the app expects on a card.
 * @returns {Array<object>} races, sorted by raceNumber ascending
 */
export function normalizeCard(parsedRaces) {
  const races = parsedRaces.map(({ raceHeader, ppHorses, sfaByKey, qsByKey }) =>
    normalizeRace(raceHeader, ppHorses, sfaByKey, qsByKey)
  );
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return races;
}
