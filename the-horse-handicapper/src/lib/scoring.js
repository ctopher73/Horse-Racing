// ============================================================================
// SCORING ENGINE — pure functions, no React, no DOM.
// Speed/form, pace fit, class/surface/distance, trainer/jockey (win% + ROI),
// workouts/layoff, odds value, composite scoring, Kelly Criterion sizing,
// chaos/skip-race detection, and confidence/bet-recommendation logic.
//
// Every function here is a pure transformation: race/horse data in, scores
// or recommendations out. No side effects, no storage, no UI. This is what
// the Racing AI / Horse Handicapper AI reads from, and what the Races and
// Bankroll tabs render — there is exactly one scoring implementation in the
// app, and everything else narrates or displays its output.
// ============================================================================

export const WEIGHTS = {
  speedForm: 0.25,
  paceFit: 0.20,
  classFit: 0.15,
  trainerJockey: 0.15,
  workoutsLayoff: 0.10,
  oddsValue: 0.15,
};

// Premium palette tiers — gold/green/brick against a dark-green/black ground.
export const TIERS = [
  { min: 85, label: "A", color: "#3FA65A", name: "Standout" },
  { min: 70, label: "B", color: "#D4AF37", name: "Solid" },
  { min: 55, label: "C", color: "#B8924A", name: "Playable" },
  { min: 40, label: "D", color: "#8B6F3F", name: "Marginal" },
  { min: 0, label: "F", color: "#A53F3F", name: "Toss" },
];

// Kelly Criterion sizing tiers — fraction of full Kelly actually recommended.
// Full Kelly is mathematically optimal for log-growth but brutally volatile;
// a fractional cap is standard practice for recreational/semi-pro bettors.
export const KELLY_FRACTION_CAP = 0.25; // quarter-Kelly ceiling
export const KELLY_MAX_PCT_OF_BANKROLL = 0.05; // hard cap regardless of Kelly math

import { cryptoId, clamp } from "./utils.js";

// ---------------------------------------------------------------------------
// ODDS HELPERS
// ---------------------------------------------------------------------------
// Accepts "5/2", "5-2", "2.5", "5to2", "evens", "even"
export function parseOddsToDecimal(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (s === "even" || s === "evens" || s === "ev") return 1.0;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*[\/\-]\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = parseFloat(m[1]);
    const den = parseFloat(m[2]);
    if (den > 0) return num / den;
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*to\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const num = parseFloat(m[1]);
    const den = parseFloat(m[2]);
    if (den > 0) return num / den;
  }
  const f = parseFloat(s);
  if (!isNaN(f)) return f;
  return null;
}

export function decimalOddsToImpliedProb(decOdds) {
  if (decOdds == null || decOdds < 0) return null;
  return 1 / (decOdds + 1);
}

export function formatOddsFraction(decOdds) {
  if (decOdds == null) return "—";
  if (Math.abs(decOdds - 1) < 0.001) return "Evens";
  // try to express as simple fraction
  const denominators = [1, 2, 3, 4, 5, 10];
  let best = null;
  for (const d of denominators) {
    const n = decOdds * d;
    if (Math.abs(n - Math.round(n)) < 0.06) {
      best = `${Math.round(n)}/${d}`;
      break;
    }
  }
  return best || decOdds.toFixed(1) + "/1";
}

// ---------------------------------------------------------------------------
// ODDS SNAPSHOT / MOVEMENT / SMART-MONEY ENGINE
// ---------------------------------------------------------------------------
// IMPORTANT — this is manually-captured data, not a live feed. Every snapshot
// is created by the person tapping "Capture odds snapshot," entering the
// board odds they're looking at right now. The shape (timestamp + source)
// is designed so a future live API integration could push entries with
// source: "api" without any change to the history/movement/alert logic below.

export function currentDecOdds(horse) {
  return parseOddsToDecimal(horse.liveOdds) ?? parseOddsToDecimal(horse.mlOdds);
}

// Adds one snapshot entry to a horse's history if odds actually changed
// (or if there's no history yet). Returns the updated horse object.
export function appendOddsSnapshot(horse, timestamp) {
  const decOdds = currentDecOdds(horse);
  const last = horse.oddsHistory[horse.oddsHistory.length - 1];
  if (last && last.decOdds === decOdds) {
    return horse; // no change since last snapshot — don't pad history with duplicates
  }
  const entry = {
    id: cryptoId(),
    timestamp,
    mlOdds: horse.mlOdds,
    liveOdds: horse.liveOdds,
    decOdds,
    source: "manual",
  };
  return { ...horse, oddsHistory: [...horse.oddsHistory, entry] };
}

// Snapshots every active (non-scratched, named) horse in a race at once —
// this is the "tote board refresh" action the user taps between races.
export function snapshotRaceOdds(race) {
  const timestamp = new Date().toISOString();
  return {
    ...race,
    horses: race.horses.map((h) => (h.name && h.name.trim() ? appendOddsSnapshot(h, timestamp) : h)),
  };
}

// Movement direction + magnitude between the first and most recent snapshot.
// "Steam" = odds shortening (more money coming in, market likes it more).
// "Drift" = odds lengthening (market souring on it / money leaving).
export function oddsMovement(horse) {
  const history = horse.oddsHistory || [];
  if (history.length < 2) return null;
  const first = history[0];
  const latest = history[history.length - 1];
  if (first.decOdds == null || latest.decOdds == null) return null;
  const delta = latest.decOdds - first.decOdds; // negative = steaming (shortened)
  const pctChange = first.decOdds > 0 ? (delta / first.decOdds) * 100 : 0;
  let direction = "stable";
  if (pctChange <= -15) direction = "steam";
  else if (pctChange >= 15) direction = "drift";
  return {
    firstDecOdds: first.decOdds,
    latestDecOdds: latest.decOdds,
    delta,
    pctChange,
    direction,
    snapshotCount: history.length,
    firstTimestamp: first.timestamp,
    latestTimestamp: latest.timestamp,
  };
}

// Smart-money heuristic: a horse whose odds are steaming significantly while
// its score doesn't (yet) fully explain the move is flagged as possible
// informed/insider money. This is a heuristic on observed price action,
// not a claim about who is betting or why.
export function smartMoneyFlag(horse, movement, composite) {
  if (!movement) return null;
  if (movement.direction !== "steam") return null;
  if (movement.snapshotCount < 2) return null;
  // Bigger flag when the move is sharp (>= 25% shortening) regardless of score,
  // and an even stronger flag when the score doesn't already justify a short price.
  const sharp = movement.pctChange <= -25;
  const scoreJustifies = composite >= 70;
  if (!sharp && scoreJustifies) return null; // expected shortening for a legitimately strong horse
  return {
    strength: sharp && !scoreJustifies ? "strong" : sharp ? "moderate" : "mild",
    pctChange: movement.pctChange,
  };
}

export function formatMovementSummary(movement) {
  if (!movement) return "No movement data yet";
  const arrow = movement.direction === "steam" ? "↓" : movement.direction === "drift" ? "↑" : "→";
  const pct = Math.abs(movement.pctChange).toFixed(0);
  if (movement.direction === "stable") return `${arrow} Stable (${movement.snapshotCount} snapshots)`;
  const verb = movement.direction === "steam" ? "Steaming" : "Drifting";
  return `${arrow} ${verb} ${pct}% (${formatOddsFraction(movement.firstDecOdds)} → ${formatOddsFraction(movement.latestDecOdds)})`;
}

// ---------------------------------------------------------------------------
// SCORING ENGINE
// ---------------------------------------------------------------------------
// Each sub-score returns 0-100. Final = weighted sum.

function scoreSpeedForm(h) {
  let score = 50;
  const figs = (h.speedFigs || "")
    .split(",")
    .map((x) => parseFloat(x.trim()))
    .filter((x) => !isNaN(x));
  if (figs.length) {
    const avg = figs.reduce((a, b) => a + b, 0) / figs.length;
    // normalize: assume typical claiming/allowance fig range 60-100 at this level
    score = clamp(((avg - 55) / (100 - 55)) * 100, 0, 100);
    // trend bonus: improving figs (most recent first) get a bump
    if (figs.length >= 2) {
      const trend = figs[0] - figs[figs.length - 1];
      score += clamp(trend * 1.5, -10, 10);
    }
  }
  const finishes = (h.last3Finishes || "")
    .split(/[-,]/)
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => !isNaN(x));
  if (finishes.length) {
    const avgFinish = finishes.reduce((a, b) => a + b, 0) / finishes.length;
    const finishScore = clamp(((6 - avgFinish) / 5) * 100, 0, 100);
    score = figs.length ? score * 0.7 + finishScore * 0.3 : finishScore;
  }
  return clamp(score, 0, 100);
}

function scorePaceFit(h, allHorses) {
  // Uses the shared pace projection engine so the score and the visible
  // race-shape summary always agree with each other.
  const projection = projectPaceShape(allHorses);
  const style = h.runningStyle || "P";
  const epr = parseFloat(h.earlyPaceRating);

  let base = 50;
  if (projection.shape === "lone_speed") {
    if (style === "E") base = 88;
    else if (style === "EP") base = 70;
    else if (style === "P") base = 55;
    else base = 40;
  } else if (projection.shape === "speed_duel") {
    if (style === "S") base = 85;
    else if (style === "P") base = 70;
    else if (style === "EP") base = 45;
    else base = 30;
  } else if (projection.shape === "contested") {
    if (style === "S") base = 72;
    else if (style === "P") base = 68;
    else if (style === "EP") base = 55;
    else base = 45;
  } else {
    if (style === "EP") base = 72;
    else if (style === "P") base = 65;
    else if (style === "E") base = 58;
    else base = 50;
  }

  if (!isNaN(epr)) {
    base += clamp((epr - 50) / 5, -8, 8);
  }
  return clamp(base, 0, 100);
}

function scoreClassFit(h) {
  let score = parseFloat(h.classRating);
  if (isNaN(score)) score = 55;
  const surfMod = { strong: 10, neutral: 0, weak: -15 }[h.surfaceFit || "neutral"];
  const distMod = { strong: 10, neutral: 0, weak: -15 }[h.distanceFit || "neutral"];
  return clamp(score + surfMod + distMod, 0, 100);
}

function scoreTrainerJockey(h) {
  const tw = parseFloat(h.trainerWinPct);
  const jw = parseFloat(h.jockeyWinPct);
  const combo = parseFloat(h.trainerJockeyComboWinPct);
  const tROI = parseFloat(h.trainerROI);
  const jROI = parseFloat(h.jockeyROI);
  const cROI = parseFloat(h.comboROI);

  const parts = [];
  if (!isNaN(tw)) parts.push(clamp((tw / 30) * 100, 0, 100));
  if (!isNaN(jw)) parts.push(clamp((jw / 30) * 100, 0, 100));
  if (!isNaN(combo)) parts.push(clamp((combo / 35) * 100, 0, 100) * 1.15);

  // ROI is a distinct signal from win% — a trainer can win often at short
  // prices (low ROI) or win less often but at prices that pay (high ROI).
  // ROI is expressed as $ returned per $1 bet; 1.00 = breakeven.
  const roiParts = [];
  if (!isNaN(tROI)) roiParts.push(clamp(((tROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100));
  if (!isNaN(jROI)) roiParts.push(clamp(((jROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100));
  if (!isNaN(cROI)) roiParts.push(clamp(((cROI - 0.6) / (1.6 - 0.6)) * 100, 0, 100) * 1.1);

  if (!parts.length && !roiParts.length) return 50;
  const winPctAvg = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  const roiAvg = roiParts.length ? roiParts.reduce((a, b) => a + b, 0) / roiParts.length : null;

  if (winPctAvg != null && roiAvg != null) {
    // Weight win% slightly higher since it's a larger sample in most cases,
    // but ROI meaningfully shifts the score — a low-ROI high-win% trainer
    // is often just running short-priced favorites that don't profit.
    return clamp(winPctAvg * 0.6 + roiAvg * 0.4, 0, 100);
  }
  return clamp(winPctAvg ?? roiAvg, 0, 100);
}

// LAYOFF ANALYSIS — returns a labeled, explainable breakdown (not just a number)
export function analyzeLayoff(h) {
  const layoff = parseFloat(h.layoffDays);
  if (isNaN(layoff)) {
    return { score: 55, label: "Unknown", detail: "No layoff data entered.", hasData: false };
  }
  if (layoff <= 21) {
    return { score: 63, label: "Fresh", detail: `${layoff}d off — racing into form, minimal rust concern.`, hasData: true };
  }
  if (layoff <= 45) {
    return { score: 57, label: "Normal cycle", detail: `${layoff}d off — typical spacing between starts.`, hasData: true };
  }
  if (layoff <= 90) {
    return { score: 47, label: "Moderate layoff", detail: `${layoff}d off — some rust risk unless workouts are sharp.`, hasData: true };
  }
  if (layoff <= 180) {
    return { score: 37, label: "Long layoff", detail: `${layoff}d off — significant time away; needs strong work tab to trust.`, hasData: true };
  }
  return { score: 25, label: "Very long layoff", detail: `${layoff}d off — extended absence, hardest to trust off the bench.`, hasData: true };
}

// WORKOUT ANALYSIS — labeled grade plus the raw work line for the person to read
export function analyzeWorkout(h) {
  const quality = h.workoutQuality || "neutral";
  const gradeMap = {
    sharp: { score: 80, label: "Sharp", detail: "Recent works graded sharp — bullet or near-bullet times." },
    neutral: { score: 55, label: "Adequate", detail: "Works are unremarkable — neither a red flag nor a standout." },
    dull: { score: 30, label: "Dull", detail: "Works graded dull — below-par times for the barn or surface." },
  };
  const grade = gradeMap[quality] || gradeMap.neutral;
  return {
    score: grade.score,
    label: grade.label,
    detail: grade.detail,
    workLine: h.workouts || "No workout line entered.",
    hasData: !!h.workouts || quality !== "neutral",
  };
}

function scoreWorkoutsLayoff(h) {
  const layoff = analyzeLayoff(h);
  const workout = analyzeWorkout(h);
  // Workout quality matters slightly more than raw layoff days, since a sharp
  // work tab can mitigate rust concerns from time off.
  return clamp(layoff.score * 0.45 + workout.score * 0.55, 0, 100);
}

function scoreOddsValue(h, fairProb) {
  // fairProb: this horse's modeled win probability (from non-odds scores)
  // compare to market implied prob from ML/live odds
  const decOdds = currentDecOdds(h);
  const marketProb = decimalOddsToImpliedProb(decOdds);
  if (marketProb == null || fairProb == null) return 50;
  const edge = fairProb - marketProb; // positive = underlay value
  // scale: +20 edge points -> ~100, -20 -> 0, 0 -> 50
  return clamp(50 + edge * 250, 0, 100);
}

// Build full score breakdown + composite for one horse within a race
// ---------------------------------------------------------------------------
// PACE PROJECTION ENGINE
// ---------------------------------------------------------------------------
// Classifies the likely shape of the race based on running styles present,
// and returns structured + plain-language output so it can be shown directly
// to the person, not just used as a hidden scoring input.
export function projectPaceShape(activeHorses) {
  const styles = activeHorses.map((h) => h.runningStyle || "P");
  const counts = { E: 0, EP: 0, P: 0, S: 0 };
  styles.forEach((s) => {
    if (counts[s] != null) counts[s]++;
  });
  const total = activeHorses.length || 1;
  const earlyCount = counts.E + counts.EP;
  const earlyRatio = earlyCount / total;

  let shape, label, description;
  if (total === 0) {
    shape = "unknown";
    label = "No data";
    description = "No horses entered yet.";
  } else if (counts.E <= 1 && earlyRatio <= 0.25) {
    shape = "lone_speed";
    label = "Lone speed likely";
    description = counts.E === 1
      ? "Only one true front-runner in the field — a soft, uncontested early pace favors that horse wiring the field."
      : "No committed front-runners — pace could be soft and tactical, favoring horses near the front early.";
  } else if (earlyRatio >= 0.45) {
    shape = "speed_duel";
    label = "Speed duel likely";
    description = `${earlyCount} of ${total} horses are early types (E/EP) — a hot, contested pace is likely, which sets up for closers late.`;
  } else if (earlyRatio >= 0.3) {
    shape = "contested";
    label = "Moderately contested";
    description = `${earlyCount} of ${total} horses want the lead — some pressure on the front end, but not a guaranteed meltdown.`;
  } else {
    shape = "balanced";
    label = "Balanced pace";
    description = "Running styles are spread fairly evenly — no strong pace bias expected either way.";
  }

  return { shape, label, description, counts, earlyRatio, total };
}

function computeHorseScore(h, allActiveHorses) {
  const speedForm = scoreSpeedForm(h);
  const paceFit = scorePaceFit(h, allActiveHorses);
  const classFit = scoreClassFit(h);
  const trainerJockey = scoreTrainerJockey(h);
  const workoutsLayoff = scoreWorkoutsLayoff(h);

  // pre-odds composite used as "fair" model strength, normalized 0-1 as a probability proxy
  const preOddsComposite =
    speedForm * WEIGHTS.speedForm +
    paceFit * WEIGHTS.paceFit +
    classFit * WEIGHTS.classFit +
    trainerJockey * WEIGHTS.trainerJockey +
    workoutsLayoff * WEIGHTS.workoutsLayoff;
  const preOddsWeightSum =
    WEIGHTS.speedForm + WEIGHTS.paceFit + WEIGHTS.classFit + WEIGHTS.trainerJockey + WEIGHTS.workoutsLayoff;
  const preOddsNormalized = preOddsComposite / preOddsWeightSum; // 0-100 scale

  return {
    speedForm,
    paceFit,
    classFit,
    trainerJockey,
    workoutsLayoff,
    preOddsNormalized,
  };
}

// Convert pre-odds normalized scores across a field into fair win probabilities
// using a softmax-like distribution so they sum to ~1.
function fieldFairProbabilities(activeHorses, breakdowns) {
  const exponent = 3.2; // controls separation between contenders
  const raw = activeHorses.map((h) => Math.pow(Math.max(breakdowns[h.id].preOddsNormalized, 1), exponent));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const probs = {};
  activeHorses.forEach((h, i) => {
    probs[h.id] = raw[i] / sum;
  });
  return probs;
}

export function computeRaceScores(race) {
  const activeHorses = race.horses.filter((h) => !h.scratched && h.name && h.name.trim());
  const paceProjection = projectPaceShape(activeHorses);
  const breakdowns = {};
  activeHorses.forEach((h) => {
    breakdowns[h.id] = computeHorseScore(h, activeHorses);
  });
  const fairProbs = fieldFairProbabilities(activeHorses, breakdowns);

  const results = activeHorses.map((h) => {
    const b = breakdowns[h.id];
    const oddsValue = scoreOddsValue(h, fairProbs[h.id]);
    const composite =
      b.speedForm * WEIGHTS.speedForm +
      b.paceFit * WEIGHTS.paceFit +
      b.classFit * WEIGHTS.classFit +
      b.trainerJockey * WEIGHTS.trainerJockey +
      b.workoutsLayoff * WEIGHTS.workoutsLayoff +
      oddsValue * WEIGHTS.oddsValue;
    const decOdds = currentDecOdds(h);
    const marketProb = decimalOddsToImpliedProb(decOdds);
    const compositeClamped = clamp(composite, 0, 100);
    const movement = oddsMovement(h);
    const smartMoney = smartMoneyFlag(h, movement, compositeClamped);
    return {
      horse: h,
      breakdown: { ...b, oddsValue },
      layoff: analyzeLayoff(h),
      workout: analyzeWorkout(h),
      movement,
      smartMoney,
      fairProb: fairProbs[h.id],
      marketProb,
      decOdds,
      composite: compositeClamped,
    };
  });

  results.sort((a, b) => b.composite - a.composite);
  return { results, paceProjection };
}

export function tierFor(score) {
  return TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
}

// ---------------------------------------------------------------------------
// KELLY CRITERION BET SIZING
// ---------------------------------------------------------------------------
// Kelly fraction f* = (bp - q) / b, where:
//   b = net decimal odds (e.g. 3/1 -> b=3, meaning win $3 per $1 staked)
//   p = model's fair win probability
//   q = 1 - p
// f* is the theoretically optimal fraction of bankroll to wager. Full Kelly
// is extremely volatile in practice (one bad run can halve a bankroll), so
// this app caps at a fraction of full Kelly AND a hard ceiling on bankroll %.
export function kellyStake(decOdds, fairProb, bankroll) {
  if (decOdds == null || fairProb == null || decOdds <= 0 || fairProb <= 0 || fairProb >= 1) {
    return { fullKellyPct: 0, recommendedPct: 0, recommendedStake: 0, edge: null, isNegativeEdge: true };
  }
  const b = decOdds;
  const p = fairProb;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  const isNegativeEdge = fullKelly <= 0;
  const fullKellyPct = clamp(fullKelly * 100, 0, 100);

  // Apply fractional Kelly cap, then a hard ceiling regardless of math,
  // since recreational/semi-pro bettors should never bet a true full-Kelly
  // stake — variance at full Kelly is brutal even when the edge is real.
  let recommendedPct = isNegativeEdge ? 0 : fullKelly * KELLY_FRACTION_CAP * 100;
  recommendedPct = clamp(recommendedPct, 0, KELLY_MAX_PCT_OF_BANKROLL * 100);
  const bankrollNum = parseFloat(bankroll) || 0;
  const recommendedStake = bankrollNum * (recommendedPct / 100);

  return {
    fullKellyPct: Math.round(fullKellyPct * 10) / 10,
    recommendedPct: Math.round(recommendedPct * 10) / 10,
    recommendedStake: Math.round(recommendedStake * 100) / 100,
    edge: (b * p - q),
    isNegativeEdge,
  };
}

// ---------------------------------------------------------------------------
// CHAOS / SKIP-RACE DETECTOR
// ---------------------------------------------------------------------------
export function assessChaos(race, scored) {
  const reasons = [];
  let chaosPoints = 0;
  const active = scored.length;

  if (active >= 10) {
    chaosPoints += 2;
    reasons.push(`Large field (${active} runners) — more trip trouble, harder to read.`);
  } else if (active >= 8) {
    chaosPoints += 1;
    reasons.push(`Full field (${active} runners) adds variance.`);
  } else if (active > 0 && active < 3) {
    chaosPoints += 3;
    reasons.push(`Only ${active} horse${active === 1 ? "" : "s"} entered — too few to read pace or build exotics confidently.`);
  }

  // Pace meltdown risk
  const earlyCount = race.horses.filter((h) => !h.scratched && (h.runningStyle === "E" || h.runningStyle === "EP")).length;
  const earlyRatio = active ? earlyCount / active : 0;
  if (earlyRatio >= 0.5 && active >= 5) {
    chaosPoints += 2;
    reasons.push("Speed duel likely — multiple early types could collapse the pace.");
  }

  // Top scores bunched together = no real standout
  if (scored.length >= 3) {
    const top3 = scored.slice(0, 3).map((s) => s.composite);
    const spread = top3[0] - top3[2];
    if (spread <= 6) {
      chaosPoints += 2;
      reasons.push("Top three horses are nearly tied on score — no clear standout.");
    } else if (spread <= 10) {
      chaosPoints += 1;
      reasons.push("Top contenders are closely bunched.");
    }
  }

  // Heavy scratches relative to original field
  const scratchedCount = race.horses.filter((h) => h.scratched).length;
  if (scratchedCount >= 2) {
    chaosPoints += 1;
    reasons.push(`${scratchedCount} scratches — field and pace shape may have changed late.`);
  }

  // Lots of horses with weak/no data (notes blank everywhere) = low confidence
  const dataPoor = race.horses.filter(
    (h) => !h.scratched && h.name && !h.speedFigs && !h.last3Finishes && !h.classRating
  ).length;
  if (dataPoor >= Math.ceil(active / 2) && active > 0) {
    chaosPoints += 2;
    reasons.push("Thin data on over half the field — model confidence is low.");
  }

  // No horse clears a "playable" floor
  if (scored.length && scored[0].composite < 55) {
    chaosPoints += 2;
    reasons.push("Even the top-rated horse scores below a playable threshold.");
  }

  const skipRace = chaosPoints >= 5;
  const level = chaosPoints >= 5 ? "high" : chaosPoints >= 3 ? "moderate" : "low";

  return { chaosPoints, reasons, skipRace, level };
}

// ---------------------------------------------------------------------------
// CONFIDENCE LEVEL
// ---------------------------------------------------------------------------
export function confidenceLevel(scored, chaos) {
  if (!scored.length) return { label: "No data", pct: 0 };
  const top = scored[0].composite;
  const second = scored[1] ? scored[1].composite : 0;
  const spread = top - second;
  let pct = clamp(top * 0.55 + spread * 3, 5, 97);
  if (chaos.level === "high") pct = clamp(pct - 25, 5, 97);
  else if (chaos.level === "moderate") pct = clamp(pct - 10, 5, 97);
  let label = "Low";
  if (pct >= 70) label = "High";
  else if (pct >= 45) label = "Medium";
  return { label, pct: Math.round(pct) };
}

// ---------------------------------------------------------------------------
// BET RECOMMENDATION ENGINE
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// BET RECOMMENDATION ENGINE (Kelly-sized)
// ---------------------------------------------------------------------------
export function buildBetRecommendations(scored, chaos, bankrollSettings) {
  if (chaos.skipRace || scored.length === 0) {
    return { skip: true, bets: [], betPass: "Pass", betPassReason: "Race flagged to skip." };
  }
  const [first, second, third, fourth] = scored;
  const bets = [];
  const bankrollAmt = parseFloat(bankrollSettings?.startingBankroll) || 0;
  const unit = parseFloat(bankrollSettings?.unitSize) || 2;

  const firstKelly = kellyStake(first.decOdds, first.fairProb, bankrollAmt);
  const stakeFor = (kelly) => {
    // Fall back to flat unit sizing if bankroll isn't set or Kelly says no edge
    if (!bankrollAmt || kelly.isNegativeEdge) return unit;
    return Math.max(1, Math.round(kelly.recommendedStake));
  };

  // WIN
  let bestWinBet = null;
  if (first.composite >= 60) {
    bestWinBet = {
      type: "Win",
      detail: `#${first.horse.programNumber || "?"} ${first.horse.name}`,
      stake: stakeFor(firstKelly),
      kelly: firstKelly,
      rationale: "Top-rated horse clears the playable threshold.",
    };
    bets.push(bestWinBet);
  }

  // PLACE
  if (first.composite >= 55 && first.composite < 75) {
    bets.push({
      type: "Place",
      detail: `#${first.horse.programNumber || "?"} ${first.horse.name}`,
      stake: unit,
      kelly: null,
      rationale: "Solid but not dominant — place cushions against an upset.",
    });
  }

  // EXACTA
  let bestExacta = null;
  if (second) {
    bestExacta = {
      type: "Exacta",
      detail: `#${first.horse.programNumber || "?"} / #${second.horse.programNumber || "?"} (key over)`,
      stake: unit,
      kelly: null,
      rationale: `Box if scores are close (gap: ${(first.composite - second.composite).toFixed(1)} pts), key straight if wide.`,
    };
    bets.push(bestExacta);
  }

  // TRIFECTA
  let bestTrifecta = null;
  if (third) {
    const names = [first, second, third].map((s) => `#${s.horse.programNumber || "?"}`).join(" / ");
    bestTrifecta = {
      type: "Trifecta",
      detail: `${names}${fourth ? ` (consider 4th: #${fourth.horse.programNumber || "?"} for box)` : ""}`,
      stake: unit,
      kelly: null,
      rationale: "Top three by score, boxed or keyed depending on confidence.",
    };
    bets.push(bestTrifecta);
  }

  // BET / PASS — a single clear call to action, separate from individual bet lines
  let betPass = "Pass";
  let betPassReason = "No bet clears the model's confidence and edge bar for this race.";
  if (bestWinBet && !firstKelly.isNegativeEdge && firstKelly.fullKellyPct > 0) {
    betPass = "Bet";
    betPassReason = `Top pick shows a positive edge at current odds (${firstKelly.fullKellyPct.toFixed(1)}% full-Kelly edge).`;
  } else if (bestWinBet) {
    betPass = "Bet (small)";
    betPassReason = "Top pick clears the score threshold, but odds don't show a strong price edge — bet light or stick to exotics.";
  }

  return { skip: false, bets, bestWinBet, bestExacta, bestTrifecta, betPass, betPassReason };
}

// ---------------------------------------------------------------------------
// RACE SUMMARY — Best Win / Best Value / Best Exacta / Best Trifecta /
// Best Longshot / Fade Favorite / Confidence / Bet-Pass, all in one place.
// ---------------------------------------------------------------------------
export function buildRaceSummary(race, bankrollSettings) {
  const { results: scored, paceProjection } = computeRaceScores(race);
  const chaos = assessChaos(race, scored);
  const confidence = confidenceLevel(scored, chaos);
  const betRec = buildBetRecommendations(scored, chaos, bankrollSettings);

  const topPick = scored[0] || null;

  // Best value = highest (fairProb - marketProb) among horses scoring decently
  let bestValue = null;
  scored.forEach((s) => {
    if (s.marketProb == null) return;
    const edge = s.fairProb - s.marketProb;
    if (s.composite >= 45 && (!bestValue || edge > bestValue.edge)) {
      bestValue = { ...s, edge };
    }
  });

  // Best longshot = decent score (>=45) but long market odds (decOdds >= 8)
  let bestLongshot = null;
  scored.forEach((s) => {
    if (s.decOdds != null && s.decOdds >= 8 && s.composite >= 45) {
      if (!bestLongshot || s.composite > bestLongshot.composite) {
        bestLongshot = s;
      }
    }
  });

  // Fade favorite = lowest market odds (favorite) whose composite score is mediocre/poor
  let fadeFavorite = null;
  let lowestOdds = Infinity;
  let favorite = null;
  scored.forEach((s) => {
    if (s.decOdds != null && s.decOdds < lowestOdds) {
      lowestOdds = s.decOdds;
      favorite = s;
    }
  });
  if (favorite && favorite.composite < 60 && favorite.horse.id !== topPick?.horse.id) {
    fadeFavorite = favorite;
  } else if (favorite && favorite.composite < 55) {
    fadeFavorite = favorite;
  }

  // Smart-money flags across the field, surfaced at race level for quick scanning
  const smartMoneyHorses = scored.filter((s) => s.smartMoney);

  return {
    scored,
    paceProjection,
    chaos,
    confidence,
    betRec,
    topPick,
    bestValue,
    bestLongshot,
    fadeFavorite,
    smartMoneyHorses,
  };
}

// ---------------------------------------------------------------------------
