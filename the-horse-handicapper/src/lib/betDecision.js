// ============================================================================
// BET DECISION LAYER — a stricter, separate filter applied AFTER scoring.
//
// WHY THIS EXISTS: the scoring engine (scoring.js) and its existing
// betRec.betPass ("Bet" / "Bet (small)" / "Pass") stay exactly as they
// were — nothing in scoring.js changes. This module reads that same
// output and applies a second, much more conservative gate on top of it,
// because real-world results showed the existing signal was too willing
// to call races "Bet" that didn't deserve it. The goal here is selectivity:
// most races should land on PASS or LEAN. A good handicapping app protects
// the bankroll by passing bad races, not by finding a reason to play every
// card.
//
// This is intentionally a pure, separate pass: race/summary in, decision
// out. Nothing here touches storage, scoring math, or existing UI fields
// (betRec, chaos, confidence, topPick, bestValue all remain untouched and
// still work everywhere they already did). Callers that want the stricter
// behavior call decideBet(summary, race) and read the result; callers that
// haven't been updated yet keep seeing the original betRec exactly as
// before.
// ============================================================================

import { clamp } from "./utils.js";

// ---------------------------------------------------------------------------
// TUNABLE THRESHOLDS — named constants so the rules are auditable and a
// future calibration pass (see betTracking.js) has one place to adjust.
// ---------------------------------------------------------------------------
export const BET_DECISION_RULES = {
  MIN_CONFIDENCE_PCT: 50, // Rule 1: confidence under this = automatic PASS
  MIN_TOP_SCORE: 70, // Rule 3: top score under this = PASS unless value edge is very strong
  STRONG_VALUE_EDGE_PCT: 8, // "very strong" value edge override for rule 3, in probability points
  MIN_SEPARATION: 5, // Rule 4: top score must lead 2nd place by at least this much
  LEAN_SEPARATION_FLOOR: 2.5, // below MIN_SEPARATION but above this = "Lean only", not a hard pass
  STRONG_BET_MIN_SCORE: 80, // top score floor to even be eligible for STRONG BET
  STRONG_BET_MIN_SEPARATION: 8, // separation floor to even be eligible for STRONG BET
  STRONG_BET_MIN_CONFIDENCE: 65, // confidence floor to even be eligible for STRONG BET
  LARGE_FIELD_SIZE: 9, // Rule 6: fields at/above this size add caution
};

// ---------------------------------------------------------------------------
// DATA QUALITY — Rule 5: missing/weak data should reduce bet confidence.
// Returns a 0-1 multiplier (1 = no penalty) applied to the decision's
// effective confidence, plus the specific gaps found so they can be shown
// as a caution reason.
// ---------------------------------------------------------------------------
function assessDataQuality(scored) {
  if (!scored.length) return { multiplier: 0, gaps: ["No horses scored."] };

  const top = scored[0].horse;
  const gaps = [];
  let missingCount = 0;
  const checks = [
    [!top.speedFigs, "speed figures"],
    [!top.classRating, "a class rating"],
    [!top.last3Finishes, "recent finish history"],
    [!top.trainerWinPct && !top.jockeyWinPct, "trainer/jockey win% data"],
    [!top.workouts && top.workoutQuality === "neutral", "workout information"],
  ];
  checks.forEach(([isMissing, label]) => {
    if (isMissing) {
      missingCount += 1;
      gaps.push(`Top pick is missing ${label}.`);
    }
  });

  // Each missing data point on the top pick chips away at how much weight
  // the decision should put on that horse's score — a 95-score horse with
  // no underlying data backing it up isn't really a 95.
  const multiplier = clamp(1 - missingCount * 0.12, 0.4, 1);
  return { multiplier, gaps, missingCount };
}

// ---------------------------------------------------------------------------
// CAUTION CONTEXT — Rule 6: maiden races, 2yo races, first-time starters,
// and large fields should increase caution. None of these are hard
// stoppers on their own, but they lower the bar for which races get
// flagged "use extra caution" in the explanation, and they reduce the
// effective confidence the decision is willing to act on.
// ---------------------------------------------------------------------------
function assessCautionContext(race, scored) {
  const reasons = [];
  let cautionPoints = 0;

  const raceTypeText = (race.raceType || "").toLowerCase();
  const isMaiden = /\bmaiden|\bmsw\b|\bmcl\b/.test(raceTypeText);
  const isTwoYearOld = /\b2\s*-?\s*yo\b|\btwo\s*year\s*old/.test(raceTypeText) || /\b2yo\b/.test(raceTypeText);

  if (isMaiden) {
    cautionPoints += 1;
    reasons.push("Maiden race — unproven horses are harder to read than runners with a form cycle.");
  }
  if (isTwoYearOld) {
    cautionPoints += 1;
    reasons.push("Two-year-old race — limited race history across the field increases uncertainty.");
  }

  const firstTimeStarters = scored.filter(
    (s) => !s.horse.last3Finishes && !s.horse.daysSinceLastRace
  ).length;
  if (firstTimeStarters > 0) {
    cautionPoints += firstTimeStarters >= 3 ? 2 : 1;
    reasons.push(
      `${firstTimeStarters} likely first-time starter${firstTimeStarters === 1 ? "" : "s"} in the field — no race-day form to confirm the model's read.`
    );
  }

  if (scored.length >= BET_DECISION_RULES.LARGE_FIELD_SIZE) {
    cautionPoints += 1;
    reasons.push(`Large field (${scored.length} runners) — more trip trouble and wider outcomes than a small field.`);
  }

  return { cautionPoints, reasons, isMaiden, isTwoYearOld, firstTimeStarters };
}

// ---------------------------------------------------------------------------
// MAIN DECISION
// ---------------------------------------------------------------------------
/**
 * @param {object} summary - output of buildRaceSummary(race, bankrollSettings)
 * @param {object} race - the race object summary was built from
 * @returns {{
 *   label: "STRONG BET"|"BET"|"LEAN"|"PASS",
 *   reasonsToBet: string[],
 *   reasonsForCaution: string[],
 *   effectiveConfidencePct: number,
 *   eligible: boolean,
 * }}
 */
export function decideBet(summary, race) {
  const { scored, chaos, confidence, bestValue, topPick } = summary;
  const reasonsToBet = [];
  const reasonsForCaution = [];

  // No data at all — nothing to decide.
  if (!scored.length || !topPick) {
    return {
      label: "PASS",
      reasonsToBet: [],
      reasonsForCaution: ["No horses entered yet."],
      effectiveConfidencePct: 0,
      eligible: false,
    };
  }

  const top = scored[0];
  const second = scored[1] || null;
  const separation = second ? top.composite - second.composite : top.composite;
  const dataQuality = assessDataQuality(scored);
  const cautionCtx = assessCautionContext(race, scored);

  // Effective confidence: start from the existing confidence%, then apply
  // the data-quality multiplier and a flat caution-points deduction. This
  // is a decision-layer concept distinct from confidence.pct — it never
  // writes back to summary.confidence, so every existing display of
  // confidence.pct is completely unaffected.
  let effectiveConfidencePct = confidence.pct * dataQuality.multiplier;
  effectiveConfidencePct = clamp(effectiveConfidencePct - cautionCtx.cautionPoints * 4, 0, 100);
  effectiveConfidencePct = Math.round(effectiveConfidencePct);

  if (dataQuality.gaps.length) reasonsForCaution.push(...dataQuality.gaps);
  if (cautionCtx.reasons.length) reasonsForCaution.push(...cautionCtx.reasons);

  // --- Rule 1: confidence floor -------------------------------------------
  if (confidence.pct < BET_DECISION_RULES.MIN_CONFIDENCE_PCT) {
    reasonsForCaution.push(`Model confidence is only ${confidence.pct}% — below the ${BET_DECISION_RULES.MIN_CONFIDENCE_PCT}% floor this app requires before recommending a bet.`);
    return finalize("PASS", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }

  // --- Rule 2: chaos gate --------------------------------------------------
  if (chaos.skipRace || chaos.level === "high") {
    reasonsForCaution.push("Race is flagged high-chaos — " + (chaos.reasons[0] || "too many unstable signals to trust a price."));
    return finalize("PASS", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }

  // --- Value edge (used by rule 3's override and surfaced either way) ----
  const valueEdgePct = bestValue ? bestValue.edge * 100 : 0;
  const hasVeryStrongValueEdge = bestValue && bestValue.horse.id === top.horse.id && valueEdgePct >= BET_DECISION_RULES.STRONG_VALUE_EDGE_PCT;
  if (hasVeryStrongValueEdge) {
    reasonsToBet.push(`Top pick is also the best value play, with a ${valueEdgePct.toFixed(1)}-point edge over the market price.`);
  }

  // --- Rule 3: top score floor ---------------------------------------------
  if (top.composite < BET_DECISION_RULES.MIN_TOP_SCORE && !hasVeryStrongValueEdge) {
    reasonsForCaution.push(`Top pick's score (${top.composite.toFixed(0)}) is below the ${BET_DECISION_RULES.MIN_TOP_SCORE} floor this app requires for a bet, and the price doesn't show a strong enough edge to make an exception.`);
    return finalize("PASS", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }
  if (top.composite >= BET_DECISION_RULES.MIN_TOP_SCORE) {
    reasonsToBet.push(`Top pick scores ${top.composite.toFixed(0)}, clearing this app's playable bar.`);
  }

  // --- Rule 4: separation from 2nd place ------------------------------------
  if (separation < BET_DECISION_RULES.MIN_SEPARATION) {
    if (separation >= BET_DECISION_RULES.LEAN_SEPARATION_FLOOR) {
      reasonsForCaution.push(`Only ${separation.toFixed(1)} points separate the top two horses — too close to call a confident bet, but not a complete coin flip either.`);
      return finalize("LEAN", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
    }
    reasonsForCaution.push(`Top two horses are separated by just ${separation.toFixed(1)} points — essentially even on the model's read.`);
    return finalize("PASS", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }
  reasonsToBet.push(`Top pick leads the second-place horse by ${separation.toFixed(1)} points — a real separation, not a coin flip.`);

  // --- Data quality / caution downgrade -------------------------------------
  // A race that otherwise clears every rule above can still get knocked
  // down to LEAN if the data backing the top pick is thin, or if multiple
  // caution signals (maiden/2yo/FTS/large field) are stacking up.
  if (dataQuality.multiplier < 0.7 || cautionCtx.cautionPoints >= 3) {
    return finalize("LEAN", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }

  // --- STRONG BET eligibility ----------------------------------------------
  if (
    top.composite >= BET_DECISION_RULES.STRONG_BET_MIN_SCORE &&
    separation >= BET_DECISION_RULES.STRONG_BET_MIN_SEPARATION &&
    confidence.pct >= BET_DECISION_RULES.STRONG_BET_MIN_CONFIDENCE &&
    cautionCtx.cautionPoints === 0
  ) {
    reasonsToBet.push(`Confidence is ${confidence.pct}%, well clear of this app's bar, with no caution flags on the field.`);
    return finalize("STRONG BET", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
  }

  return finalize("BET", reasonsToBet, reasonsForCaution, effectiveConfidencePct);
}

function finalize(label, reasonsToBet, reasonsForCaution, effectiveConfidencePct) {
  return {
    label,
    // On a final PASS, any partial "reasons to bet" gathered along the way
    // (e.g. the score cleared the floor before a later rule failed) are
    // moot and would read as a confusing mixed signal — only show them for
    // labels where a bet is actually being suggested.
    reasonsToBet: label === "PASS" ? [] : reasonsToBet,
    reasonsForCaution,
    effectiveConfidencePct,
    eligible: label !== "PASS",
  };
}

/**
 * Convenience helper: applies decideBet() across every race in a card's
 * summaries map (keyed by race id, as built in App.jsx), returning a new
 * map of the same shape keyed by race id. Does not mutate the summaries.
 * @param {object} summaries - { [raceId]: summary } as built by App.jsx
 * @param {object[]} races - the card's races, used to look up race.raceType etc.
 * @returns {object} { [raceId]: betDecision }
 */
export function decideBetsForCard(summaries, races) {
  const raceById = new Map(races.map((r) => [r.id, r]));
  const decisions = {};
  Object.keys(summaries).forEach((raceId) => {
    const race = raceById.get(raceId);
    if (!race) return;
    decisions[raceId] = decideBet(summaries[raceId], race);
  });
  return decisions;
}
