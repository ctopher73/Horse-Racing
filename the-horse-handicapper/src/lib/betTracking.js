// ============================================================================
// POST-RACE BET TRACKING — records what actually happened and compares it
// against what the model said, so the app can be calibrated against real
// results over time instead of staying a black box.
//
// This is intentionally simple and manual, matching the rest of the app's
// "the person is the data source" philosophy (see providers.js / CSV
// import) — there is no live results feed. The person enters finish order
// once a race is official; everything else (hit/miss per pick type, ROI,
// running win%) is computed from that.
//
// Persisted independently in its own localStorage key, the same pattern as
// preferences (storage.js) — so tracked history survives across cards,
// page reloads, and isn't bound to any one card's lifecycle (a card can be
// deleted; its track record shouldn't disappear with it).
// ============================================================================

const STORAGE_KEY_BET_TRACKING = "horse_handicapper_bet_tracking_v1";

// One tracked record per race, keyed by a stable composite of
// card track/date/raceNumber so re-importing or re-opening the same card
// doesn't create duplicate tracking entries.
export function raceTrackingKey(card, race) {
  return `${(card.track || "").trim().toLowerCase()}|${card.date || ""}|${race.raceNumber}`;
}

export function loadBetTrackingHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_BET_TRACKING);
    if (!raw) return defaultBetTrackingHistory();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
      return defaultBetTrackingHistory();
    }
    return parsed;
  } catch (e) {
    console.error("Failed to load bet tracking history", e);
    return defaultBetTrackingHistory();
  }
}

export function saveBetTrackingHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY_BET_TRACKING, JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save bet tracking history", e);
  }
}

function defaultBetTrackingHistory() {
  return { records: [] };
}

/**
 * One race's tracked outcome.
 * finishOrder: array of programNumber strings, winner first, in the order
 *   the person enters them (only as many positions as they choose to enter
 *   — first place is enough to score win-based metrics; more positions
 *   enable place/show-style review later without changing this shape).
 */
export function blankTrackingRecord(card, race) {
  return {
    key: raceTrackingKey(card, race),
    track: card.track || "",
    date: card.date || "",
    raceNumber: race.raceNumber,
    enteredAt: null,
    finishOrder: [], // ["4", "1", "7"] — programNumbers, winner first
    // Snapshot of what the model said at the time the race was run, so
    // later changes to scoring/decision logic don't retroactively change
    // historical comparisons.
    snapshot: null,
  };
}

/**
 * Builds the snapshot stored alongside a finish-order entry — captures
 * exactly what the model recommended at tracking time so future scoring
 * changes can't quietly rewrite history.
 */
export function buildDecisionSnapshot(summary, betDecision) {
  return {
    topPickProgramNumber: summary.topPick ? summary.topPick.horse.programNumber : null,
    topPickComposite: summary.topPick ? summary.topPick.composite : null,
    bestValueProgramNumber: summary.bestValue ? summary.bestValue.horse.programNumber : null,
    suggestedBets: (summary.betRec?.bets || []).map((b) => ({
      type: b.type,
      detail: b.detail,
      stake: b.stake,
    })),
    betDecisionLabel: betDecision ? betDecision.label : null,
    confidencePct: summary.confidence ? summary.confidence.pct : null,
  };
}

/**
 * Records (or overwrites) the finish order for one race, along with the
 * decision snapshot at the time it's entered. Returns the updated history.
 */
export function recordFinishOrder(history, card, race, finishOrder, summary, betDecision) {
  const key = raceTrackingKey(card, race);
  const record = {
    key,
    track: card.track || "",
    date: card.date || "",
    raceNumber: race.raceNumber,
    enteredAt: new Date().toISOString(),
    finishOrder: finishOrder.filter((p) => p && String(p).trim()),
    snapshot: buildDecisionSnapshot(summary, betDecision),
  };
  const existingIdx = history.records.findIndex((r) => r.key === key);
  const records =
    existingIdx === -1
      ? [...history.records, record]
      : history.records.map((r, i) => (i === existingIdx ? record : r));
  return { ...history, records };
}

export function removeTrackingRecord(history, key) {
  return { ...history, records: history.records.filter((r) => r.key !== key) };
}

// ---------------------------------------------------------------------------
// COMPARISON — what the model said vs. what happened, for one record
// ---------------------------------------------------------------------------
/**
 * @returns {{
 *   winner: string|null,
 *   topPickWon: boolean|null,
 *   bestValueWon: boolean|null,
 *   suggestedBetHits: { type: string, detail: string, hit: boolean }[],
 *   anySuggestedBetHit: boolean|null,
 * }}
 */
export function compareRecordToSnapshot(record) {
  const winner = record.finishOrder[0] || null;
  const snap = record.snapshot;
  if (!winner || !snap) {
    return {
      winner,
      topPickWon: null,
      bestValueWon: null,
      suggestedBetHits: [],
      anySuggestedBetHit: null,
    };
  }

  const topPickWon = snap.topPickProgramNumber != null ? snap.topPickProgramNumber === winner : null;
  const bestValueWon = snap.bestValueProgramNumber != null ? snap.bestValueProgramNumber === winner : null;

  // Suggested-bet hit detection: a Win bet hits if its program number won;
  // exotic types (Exacta/Trifecta) are recorded but not auto-graded here
  // since grading those correctly needs full finish order, not just the
  // winner — left as "ungraded" rather than guessed.
  const suggestedBetHits = (snap.suggestedBets || []).map((b) => {
    if (b.type !== "Win" && b.type !== "Place") {
      return { type: b.type, detail: b.detail, hit: null }; // ungraded
    }
    const match = b.detail && b.detail.match(/#(\S+)/);
    const programNumber = match ? match[1] : null;
    if (!programNumber) return { type: b.type, detail: b.detail, hit: null };
    if (b.type === "Win") {
      return { type: b.type, detail: b.detail, hit: programNumber === winner };
    }
    // Place: hits if in the top 2 of entered finish order (when available)
    const placePositions = record.finishOrder.slice(0, 2);
    return { type: b.type, detail: b.detail, hit: placePositions.includes(programNumber) };
  });

  const gradedHits = suggestedBetHits.filter((h) => h.hit !== null);
  const anySuggestedBetHit = gradedHits.length ? gradedHits.some((h) => h.hit) : null;

  return { winner, topPickWon, bestValueWon, suggestedBetHits, anySuggestedBetHit };
}

// ---------------------------------------------------------------------------
// AGGREGATE STATS — across all tracked, settled records
// ---------------------------------------------------------------------------
/**
 * @returns {{
 *   totalTracked: number,
 *   topPickWinPct: number|null,
 *   bestValueWinPct: number|null,
 *   suggestedBetWinPct: number|null,
 *   byDecisionLabel: { [label: string]: { count: number, wins: number, winPct: number } },
 * }}
 */
export function computeTrackingStats(history) {
  const records = history.records.filter((r) => r.finishOrder.length && r.snapshot);
  const totalTracked = records.length;

  if (!totalTracked) {
    return {
      totalTracked: 0,
      topPickWinPct: null,
      bestValueWinPct: null,
      suggestedBetWinPct: null,
      byDecisionLabel: {},
    };
  }

  let topPickGraded = 0, topPickWins = 0;
  let bestValueGraded = 0, bestValueWins = 0;
  let suggestedGraded = 0, suggestedWins = 0;
  const byDecisionLabel = {};

  records.forEach((r) => {
    const cmp = compareRecordToSnapshot(r);
    if (cmp.topPickWon != null) {
      topPickGraded += 1;
      if (cmp.topPickWon) topPickWins += 1;
    }
    if (cmp.bestValueWon != null) {
      bestValueGraded += 1;
      if (cmp.bestValueWon) bestValueWins += 1;
    }
    if (cmp.anySuggestedBetHit != null) {
      suggestedGraded += 1;
      if (cmp.anySuggestedBetHit) suggestedWins += 1;
    }

    const label = r.snapshot.betDecisionLabel || "Unlabeled";
    if (!byDecisionLabel[label]) byDecisionLabel[label] = { count: 0, wins: 0, winPct: 0 };
    byDecisionLabel[label].count += 1;
    if (cmp.topPickWon) byDecisionLabel[label].wins += 1;
  });

  Object.keys(byDecisionLabel).forEach((label) => {
    const b = byDecisionLabel[label];
    b.winPct = b.count ? Math.round((b.wins / b.count) * 1000) / 10 : 0;
  });

  return {
    totalTracked,
    topPickWinPct: topPickGraded ? Math.round((topPickWins / topPickGraded) * 1000) / 10 : null,
    bestValueWinPct: bestValueGraded ? Math.round((bestValueWins / bestValueGraded) * 1000) / 10 : null,
    suggestedBetWinPct: suggestedGraded ? Math.round((suggestedWins / suggestedGraded) * 1000) / 10 : null,
    byDecisionLabel,
  };
}

/**
 * ROI across all tracked records that had a suggested Win bet with a stake
 * and a gradeable outcome. Assumes the recorded mlOdds/decOdds at
 * snapshot-time for payout math; this is necessarily an approximation
 * since exact final odds at post time aren't captured — flagged as such
 * wherever this number is displayed.
 */
export function computeApproximateROI(history) {
  const records = history.records.filter((r) => r.finishOrder.length && r.snapshot);
  let totalStaked = 0;
  let totalReturned = 0;
  let gradedBetCount = 0;

  records.forEach((r) => {
    const cmp = compareRecordToSnapshot(r);
    (cmp.suggestedBetHits || []).forEach((hit, i) => {
      if (hit.hit === null) return;
      const bet = r.snapshot.suggestedBets[i];
      if (!bet || !bet.stake) return;
      gradedBetCount += 1;
      totalStaked += Number(bet.stake) || 0;
      // Without captured final odds per bet, a hit is credited at even
      // money as a conservative placeholder — this undercounts true ROI
      // on winning bets at longer prices, which is the safer direction
      // for a bankroll-protection tool to err in.
      if (hit.hit) totalReturned += (Number(bet.stake) || 0) * 2;
    });
  });

  if (!gradedBetCount) return { totalStaked: 0, totalReturned: 0, roiPct: null, gradedBetCount: 0 };
  const roiPct = totalStaked ? Math.round(((totalReturned - totalStaked) / totalStaked) * 1000) / 10 : null;
  return { totalStaked, totalReturned, roiPct, gradedBetCount };
}
