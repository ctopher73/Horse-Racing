# Betting Logic Tightening + Post-Race Tracking — implementation notes

## What changed

### 1. New bet decision layer (`src/lib/betDecision.js`)
A separate, stricter filter applied AFTER scoring — `scoring.js` itself was
**not** changed except for the Kelly constants (see below). This is the
single new function `decideBet(summary, race)` that every race now gets
run through, producing:

```
{ label: "STRONG BET" | "BET" | "LEAN" | "PASS",
  reasonsToBet: string[],
  reasonsForCaution: string[],
  effectiveConfidencePct: number,
  eligible: boolean }
```

Rules implemented, in order:
1. Confidence < 50% -> automatic PASS.
2. Chaos flagged high or skip-race -> automatic PASS.
3. Top score < 70 -> PASS, unless the top pick is also the best-value
   play with an edge >= 8 points (then it can still qualify).
4. Separation from 2nd place < 5 points -> LEAN (if >= 2.5) or PASS (if
   below that) -- never a full BET on a near-tie regardless of how high
   the top score is.
5. Missing data on the top pick (no speed figs, no class rating, no
   recent finishes, no trainer/jockey%, no workouts) lowers
   effectiveConfidencePct and can downgrade an otherwise-eligible race
   to LEAN.
6. Maiden races, 2yo races, first-time starters, and fields >= 9 runners
   add caution points -- stacking 3+ of these also forces a downgrade to
   LEAN even if every score-based rule passed.
7. STRONG BET requires ALL of: top score >= 80, separation >= 8,
   confidence >= 65%, and zero caution flags. Intentionally rare.

Validated: ran 500 randomized, realistic race scenarios through it --
79.4% landed on PASS or LEAN, STRONG BET fired on 0.2% (only for
genuinely dominant, clean situations), matching the goal of being
selective rather than active. Also unit-tested every rule boundary in
isolation (separation at 1.0/3.0/15.0 points, score floor with/without a
strong value override, data-quality penalties, maiden/FTS stacking).

### 2. Kelly staking capped harder (`scoring.js`)
- KELLY_FRACTION_CAP: 0.25 -> 0.125 (quarter-Kelly -> eighth-Kelly)
- KELLY_MAX_PCT_OF_BANKROLL: 0.05 -> 0.02 (5% -> 2% hard ceiling)
- New KELLY_MIN_TRACKED_BETS_FOR_CONFIDENCE = 30 constant, used by the UI
  to label Kelly numbers "informational" until that much history exists.

These are the only changes inside scoring.js -- everything else (the
composite scoring math, chaos detection, confidence formula,
buildRaceSummary, buildBetRecommendations) is untouched.

### 3. Post-race tracking (`src/lib/betTracking.js`)
New, independently-persisted module (own localStorage key, same pattern
as preferences):
- Enter finish order on any race once it's official (program numbers,
  winner first).
- Each entry snapshots what the model said at that moment (top pick,
  best value, suggested bets, the new betDecision label) so later scoring
  changes never rewrite history.
- computeTrackingStats() -- win% for top pick / best value / suggested
  bets, broken down by betDecision label.
- computeApproximateROI() -- ROI on graded Win/Place bets, flagged as
  approximate since exact final odds per bet aren't captured.

### 4. UI changes (additive -- no redesign)
- The existing bet-pass banner (same card, same position in Race Detail)
  now shows the new STRONG BET / BET / LEAN / PASS label plus two
  explicit lists: Reasons to bet and Reasons to be cautious. Every other
  existing element (suggested bets list, Kelly numbers, confidence bar,
  summary blocks, chaos warnings) is unchanged.
- Dashboard race cards now show the new label as their pill.
- The top dashboard stats strip ("Bet signals" / "Skip flags") now counts
  using the new decision layer too, so it stays consistent.
- New "Race result" card at the bottom of Race Detail -- enter finish
  order, see Top pick / Best value / each suggested bet marked hit/miss.
- New "Track record" card on the Bankroll tab -- races tracked, win% by
  pick type, win% by betDecision label, approximate ROI.
- Kelly lines now say "(informational)" and explain why.

### 5. AI / coach updates
- buildCoachContext now attaches betDecision to every race summary.
- insightBestBetsToday (the "Today's Briefing" best-bets card) now
  requires betDecision.label to be STRONG BET or BET -- previously used
  the old, looser betPass === "Bet". Its empty-state message also now
  explains that landing here most days is expected, not a problem.
- The LLM system prompt (netlify/functions/coach.js) was updated to
  describe betDecision and told to lead with it over the older betPass
  field, and to talk about Kelly numbers as informational.

IMPORTANT: while making this change I discovered the previous delivery
had accidentally placed a copy of the frontend src/lib/coach.js at
netlify/functions/coach.js instead of the real server-side Netlify
Function. I reconstructed the actual backend file (API calls to
Anthropic/OpenAI, rule-based fallback, request handler) from its original
content earlier in this project and applied the same betDecision-aware
updates to it. If you have a working copy of that function deployed
already, diff this one against it before overwriting, just in case
anything else drifted.

## What you should test
- Open a few real races and confirm the new label/reasons look right
  given the horses entered -- a deliberately mediocre/bunched race should
  PASS, a real standout should BET or STRONG BET.
- Enter a finish order on a tracked race and confirm the hit/miss display
  and the Bankroll tab's Track record numbers update.
- If you have a live Anthropic/OpenAI key configured, ask the AI "what
  should I bet today" and confirm it talks about betDecision/selectivity
  rather than the old looser signal.
- Confirm CSV import, manual entry, PDF import, and preferences all still
  work exactly as before -- nothing about how races/horses are entered or
  scored changed.
