// netlify/functions/racecard.js
//
// Server-side proxy for fetching a race card (track + date) from a racing
// data provider. This exists so the API key never reaches the browser —
// the frontend calls THIS function, and this function calls the real
// provider using credentials stored in Netlify environment variables.
//
// Default provider: The Racing API (https://www.theracingapi.com)
//   - Auth: HTTP Basic (username:password, base64-encoded)
//   - Env vars required: RACING_API_USERNAME, RACING_API_PASSWORD
//   - Core API coverage is UK/Ireland/Hong Kong by default. US/Canada
//     tracks (including Lone Star Park) require their separate "North
//     America" regional data add-on — a base subscription will NOT return
//     US racecards. Confirm your plan covers the track you're requesting.
//   - The Racing API's terms of service prohibit use by betting operators/
//     sportsbooks. This app is a personal handicapping tool, not an
//     operator — but read their ToS yourself before relying on this in
//     production: https://www.theracingapi.com/terms-of-service
//
// SWITCHING PROVIDERS LATER:
//   Everything provider-specific lives in fetchFromRacingApi() and
//   mapProviderResponseToRaces() below. To use a different provider,
//   write a new fetch function with the same return shape (raw provider
//   JSON) and a new mapper that converts it to this app's race/horse
//   shape, then swap which pair gets called in the handler. The response
//   contract this function returns to the frontend does not need to change.

const RACING_API_BASE = "https://api.theracingapi.com/v1";

// ---------------------------------------------------------------------------
// PROVIDER CALL — The Racing API
// ---------------------------------------------------------------------------
async function fetchFromRacingApi(track, date) {
  const username = process.env.RACING_API_USERNAME;
  const password = process.env.RACING_API_PASSWORD;

  if (!username || !password) {
    throw new ProviderConfigError(
      "RACING_API_USERNAME and RACING_API_PASSWORD are not set in Netlify environment variables. " +
      "Add them in Site configuration → Environment variables, then redeploy."
    );
  }

  const authHeader = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  // The Racing API's racecards endpoints return ALL meetings/courses for a
  // given date, not a single track — so we fetch by date and filter by
  // course name ourselves. Using the "standard" tier endpoint here; swap to
  // /racecards/pro if your plan includes it and you want the richer payload
  // (trainer_14_days, prev_trainers, quotes, etc. — see the mapper below for
  // which of those fields are actually used).
  const url = `${RACING_API_BASE}/racecards/standard?date=${encodeURIComponent(date)}`;

  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authHeader },
    });
  } catch (networkErr) {
    throw new ProviderFetchError(`Network error reaching The Racing API: ${networkErr.message}`);
  }

  if (response.status === 401) {
    throw new ProviderFetchError(
      "The Racing API rejected the request as unauthorized (401). Check that RACING_API_USERNAME and " +
      "RACING_API_PASSWORD are correct, and that your subscription is active."
    );
  }
  if (response.status === 429) {
    throw new ProviderFetchError("The Racing API rate limit was exceeded (429). Wait a moment and try again.");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ProviderFetchError(`The Racing API returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json().catch(() => {
    throw new ProviderFetchError("The Racing API returned a response that was not valid JSON.");
  });

  // The racecards/standard payload groups races by course. Filter down to
  // the requested track. Matching is case-insensitive and tolerant of the
  // API including a region suffix or surface note in the course name
  // (e.g. "Lone Star Park (AW)").
  const allRacecards = Array.isArray(data?.racecards) ? data.racecards : [];
  const normalizedTrack = track.trim().toLowerCase();
  const matching = allRacecards.filter((rc) => {
    const course = String(rc.course || "").toLowerCase();
    return course.includes(normalizedTrack) || normalizedTrack.includes(course);
  });

  if (matching.length === 0) {
    throw new ProviderNoDataError(
      `No racecards found for "${track}" on ${date}. This can mean: the track didn't race that day, ` +
      `the spelling doesn't match the provider's course name, or — if this is a US/Canada track — your ` +
      `plan doesn't include the North America regional add-on required for that coverage.`
    );
  }

  return matching;
}

// ---------------------------------------------------------------------------
// RESPONSE MAPPING — provider JSON -> this app's race/horse shape
// ---------------------------------------------------------------------------
// Maps The Racing API's racecard fields onto the shape blankRace()/blankHorse()
// in src/App.jsx expect, so imported data slots directly into the existing
// scoring engine with no further transformation needed on the frontend.
function mapProviderResponseToRaces(racecards) {
  return racecards.map((rc, idx) => {
    const runners = Array.isArray(rc.runners) ? rc.runners : [];
    return {
      raceNumber: idx + 1,
      postTime: rc.off_time || "",
      surface: mapSurface(rc.surface),
      distance: rc.distance || rc.distance_round || "",
      raceType: [rc.race_class, rc.race_name].filter(Boolean).join(" — "),
      purse: rc.prize || "",
      fieldSizeNote: rc.field_size || "",
      horses: runners.map((r) => mapRunnerToHorse(r)),
    };
  });
}

function mapSurface(rawSurface) {
  const s = String(rawSurface || "").toLowerCase();
  if (s.includes("turf")) return "Turf";
  if (s === "aw" || s.includes("all weather") || s.includes("synthetic") || s.includes("tapeta") || s.includes("polytrack")) {
    return "Synthetic";
  }
  return "Dirt";
}

// Converts a decimal-form fraction string if present; The Racing API's core
// racecards endpoints don't always include odds (depends on plan/endpoint —
// see getOdds Runner for a dedicated odds endpoint on higher tiers). This
// function degrades gracefully to blank odds rather than guessing a price.
function extractOdds(runner) {
  // Some provider tiers attach an "odds" array per runner with bookmaker
  // prices; if present, take the first one as a representative morning line.
  if (Array.isArray(runner.odds) && runner.odds.length > 0) {
    const first = runner.odds[0];
    if (first && first.fractional) return String(first.fractional);
    if (first && first.decimal) return String(first.decimal);
  }
  return "";
}

function mapRunnerToHorse(r) {
  return {
    programNumber: r.number || "",
    name: r.horse || "",
    jockey: r.jockey || "",
    trainer: r.trainer || "",
    mlOdds: extractOdds(r),
    liveOdds: "",
    scratched: false, // The Racing API marks non-runners separately on raceday updates; see note below
    last3Finishes: parseFormString(r.form),
    speedFigs: [r.rpr, r.ts, r.ofr].filter((v) => v != null && v !== "").join(","),
    daysSinceLastRace: r.last_run || "",
    runningStyle: "P", // not provided by this endpoint — defaults to neutral; correct manually if known
    earlyPaceRating: "",
    classRating: r.ofr || "",
    surfaceFit: "neutral",
    distanceFit: "neutral",
    trainerWinPct: pctFromTrainer14Days(r.trainer_14_days),
    jockeyWinPct: "",
    trainerJockeyComboWinPct: "",
    jockeyROI: "",
    trainerROI: "",
    comboROI: "",
    workouts: "",
    workoutQuality: "neutral",
    layoffDays: r.last_run || "",
    expertPicks: r.comment || "",
    socialNotes: "",
    notes: r.spotlight || "",
    dataSource: "api",
  };
}

function pctFromTrainer14Days(t14) {
  if (!t14 || t14.percent == null) return "";
  return String(t14.percent);
}

// Form strings from The Racing API look like "3000-2" (most recent last,
// dash = season break). This app's Last3Finishes field expects most-recent
// digits separated by dashes; we take the last 3 finish characters in
// reverse so the convention matches the rest of the app (recent-first).
function parseFormString(form) {
  if (!form) return "";
  const digits = String(form).replace(/[^0-9]/g, "");
  if (!digits.length) return "";
  return digits.split("").slice(-3).reverse().join("-");
}

// ---------------------------------------------------------------------------
// ERROR TYPES — distinguish config problems from provider/network problems
// so the frontend can show an accurate, actionable message instead of a
// generic failure.
// ---------------------------------------------------------------------------
class ProviderConfigError extends Error {}
class ProviderFetchError extends Error {}
class ProviderNoDataError extends Error {}

// ---------------------------------------------------------------------------
// HANDLER (Netlify Functions v2 — web-standard Request/Response)
// ---------------------------------------------------------------------------
export default async (req) => {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed. Use GET." }, { status: 405 });
  }

  const url = new URL(req.url);
  const track = (url.searchParams.get("track") || "").trim();
  const date = (url.searchParams.get("date") || "").trim();

  if (!track || !date) {
    return Response.json(
      { error: "Both 'track' and 'date' query parameters are required, e.g. ?track=Lone+Star+Park&date=2026-06-27" },
      { status: 400 }
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "'date' must be in YYYY-MM-DD format." }, { status: 400 });
  }

  try {
    const racecards = await fetchFromRacingApi(track, date);
    const races = mapProviderResponseToRaces(racecards);
    return Response.json({
      track,
      date,
      source: "The Racing API",
      races,
    });
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return Response.json({ error: err.message, kind: "config" }, { status: 500 });
    }
    if (err instanceof ProviderNoDataError) {
      return Response.json({ error: err.message, kind: "no_data" }, { status: 404 });
    }
    if (err instanceof ProviderFetchError) {
      return Response.json({ error: err.message, kind: "provider" }, { status: 502 });
    }
    console.error("Unexpected error in racecard function:", err);
    return Response.json({ error: "Unexpected server error fetching race card.", kind: "unknown" }, { status: 500 });
  }
};
