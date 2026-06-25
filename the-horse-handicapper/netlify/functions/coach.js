// netlify/functions/coach.js
//
// Server-side endpoint for The Horse Handicapper AI chat. The frontend sends the
// already-serialized race context (scores, rankings, pace, odds history,
// bankroll, bet/pass recommendations, smart-money flags — see
// serializeCoachContext() in src/App.jsx) plus the user's question and
// recent conversation history. This function decides how to answer:
//
//   1. If ANTHROPIC_API_KEY is set, call Claude.
//   2. Else if OPENAI_API_KEY is set, call OpenAI.
//   3. Else (or if either call fails), fall back to a rule-based answer
//      computed here, server-side, using the same intent-matching approach
//      as the frontend's rule-based provider — so the person always gets a
//      real answer, never an error screen.
//
// API keys live ONLY in Netlify environment variables (Site configuration →
// Environment variables) and are never sent to or readable from the browser.
// The frontend only ever talks to this function, never to OpenAI/Anthropic
// directly.

const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const OPENAI_MODEL = "gpt-5";

// ---------------------------------------------------------------------------
// SYSTEM PROMPT — instructs the model to stay grounded in the provided data
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are The Horse Handicapper AI, a horse racing handicapping assistant built into The Horse Handicapper app.

You will be given a JSON snapshot of the user's currently active race card: every race's scores, sub-scores, pace projection, confidence level, bet/pass recommendation, suggested bets with Kelly-derived stakes, odds history, and smart-money flags, plus the user's bankroll settings.

The JSON may also include a "userPreferences" field (preferred tracks, favorite bet types, risk tolerance, answer style). It is only present when the user has opted in to personalized advice. When present:
- Mention their preferred tracks by name when the active card matches one.
- Lean toward mentioning their favorite bet types first when several options are similarly strong.
- Let risk tolerance shape your framing: "conservative" should sound more cautious about marginal plays, "aggressive" can be more willing to highlight longshots and value, "balanced" is neutral.
- Match "answerStyle": direct (default, short and confident), detailed (more explanation), or concise (as brief as possible).
- Never let preferences override the underlying data — they shape tone and emphasis only, never the scores, recommendations, or facts themselves.
When "userPreferences" is absent or null, answer neutrally with no personalization.

Rules you must follow:
- Base every answer ONLY on the data in the provided context. Do not invent horses, scores, odds, or races that are not in the data.
- Do not claim knowledge of real-world horse racing, jockeys, or trainers beyond what's in the context — you have no information about the actual real-world race.
- If the context doesn't contain enough information to answer (e.g. asking about a race number that doesn't exist, or data fields that are empty), say so plainly rather than guessing.
- Speak like a sharp, direct handicapping friend — concise, confident where the data supports it, honest about uncertainty where it doesn't.
- Never present a recommendation as a guarantee. Bet/pass calls, value flags, and confidence levels are the model's read, not certainties.
- Keep answers focused and skimmable on a phone screen — short paragraphs, no long preambles.`;

// ---------------------------------------------------------------------------
// PROVIDER CALLS
// ---------------------------------------------------------------------------
async function callAnthropic(apiKey, context, question, history) {
  const messages = buildConversationMessages(history, question);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      system: `${SYSTEM_PROMPT}\n\nRace card context (JSON):\n${JSON.stringify(context)}`,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b.type === "text") : null;
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("Anthropic API response did not contain a text block.");
  }
  return textBlock.text;
}

async function callOpenAI(apiKey, context, question, history) {
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nRace card context (JSON):\n${JSON.stringify(context)}` },
    ...buildConversationMessages(history, question),
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 600,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error("OpenAI API response did not contain message content.");
  }
  return text;
}

// Converts the frontend's { role: "user"|"coach", text }[] history into the
// { role: "user"|"assistant", content }[] shape both provider APIs expect,
// then appends the new question as the final user turn.
function buildConversationMessages(history, question) {
  const messages = (history || []).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  messages.push({ role: "user", content: question });
  return messages;
}

// ---------------------------------------------------------------------------
// SERVER-SIDE RULE-BASED FALLBACK
// ---------------------------------------------------------------------------
// Mirrors the intent-matching approach of the frontend's rule-based provider,
// but operates on the serialized (already-flattened) context shape sent over
// the wire, since this function never has access to the frontend's live
// React state or the richer in-memory objects — only the JSON payload.
function ruleBasedFallback(context, question) {
  const q = (question || "").toLowerCase();

  const raceMatch = q.match(/race\s*(\d+)/);
  if (raceMatch) {
    const num = parseInt(raceMatch[1], 10);
    const race = context.races.find((r) => r.raceNumber === num);
    if (!race) return `I don't have Race ${num} loaded on this card.`;
    return describeRace(race);
  }

  if (/skip|pass|avoid|chaotic/.test(q)) {
    const skips = context.races.filter((r) => r.chaos.skipRace);
    if (!skips.length) return "No races are currently flagged to skip on this card.";
    return `Races flagged to skip: ${skips.map((r) => `Race ${r.raceNumber} (${r.chaos.reasons[0] || "chaotic"})`).join("; ")}.`;
  }

  if (/value/.test(q)) {
    const withValue = context.races
      .map((r) => ({ r, h: r.horses.find((h) => h.isBestValue) }))
      .filter((x) => x.h);
    if (!withValue.length) return "No standout value horses identified on this card right now.";
    return withValue
      .map(({ r, h }) => `Race ${r.raceNumber}: #${h.programNumber || "?"} ${h.name} at ${h.liveOdds || h.mlOdds || "—"} (score ${h.compositeScore})`)
      .join(" | ");
  }

  if (/favorite|fade/.test(q)) {
    const fades = context.races
      .map((r) => ({ r, h: r.horses.find((h) => h.isFadeFavorite) }))
      .filter((x) => x.h);
    if (!fades.length) return "No favorites currently look vulnerable on this card.";
    return fades
      .map(({ r, h }) => `Race ${r.raceNumber}: #${h.programNumber || "?"} ${h.name} at ${h.liveOdds || h.mlOdds || "—"} only scores ${h.compositeScore}`)
      .join(" | ");
  }

  if (/bankroll|stake|unit|money/.test(q)) {
    const total = context.races.reduce(
      (sum, r) => sum + (r.chaos.skipRace ? 0 : r.suggestedBets.reduce((s, b) => s + (Number(b.stake) || 0), 0)),
      0
    );
    const bankroll = parseFloat(context.bankroll.startingBankroll) || 0;
    if (!bankroll) return "No starting bankroll is set yet — add one on the Bankroll tab for sizing context.";
    return `Suggested stakes across this card total $${total.toFixed(0)}, about ${Math.round((total / bankroll) * 100)}% of your $${bankroll.toFixed(0)} bankroll.`;
  }

  const betRaces = context.races.filter((r) => !r.chaos.skipRace && r.betPass === "Bet");
  if (!betRaces.length) {
    return "No race currently clears a full BET signal on this card.";
  }
  const best = betRaces
    .map((r) => ({ r, h: r.horses.find((h) => h.isTopPick) }))
    .filter((x) => x.h)
    .sort((a, b) => b.h.compositeScore - a.h.compositeScore)[0];
  if (!best) return "No race currently clears a full BET signal on this card.";
  return `Top bet on the card: #${best.h.programNumber || "?"} ${best.h.name} in Race ${best.r.raceNumber} (score ${best.h.compositeScore}, ${best.r.confidence.label.toLowerCase()} confidence).`;
}

function describeRace(race) {
  if (race.chaos.skipRace) {
    return `Race ${race.raceNumber} is flagged to skip. ${race.chaos.reasons.join(" ")}`;
  }
  const top = race.horses.find((h) => h.isTopPick);
  const value = race.horses.find((h) => h.isBestValue);
  const fade = race.horses.find((h) => h.isFadeFavorite);
  const parts = [`Race ${race.raceNumber} — ${race.betPass}, ${race.confidence.label.toLowerCase()} confidence (${race.confidence.pct}%).`];
  if (top) parts.push(`Top pick: #${top.programNumber || "?"} ${top.name} (score ${top.compositeScore}).`);
  if (value) parts.push(`Best value: #${value.programNumber || "?"} ${value.name}.`);
  if (fade) parts.push(`Fade candidate: #${fade.programNumber || "?"} ${fade.name}.`);
  parts.push(`Pace read: ${race.paceProjection.label}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// HANDLER (Netlify Functions v2 — web-standard Request/Response)
// ---------------------------------------------------------------------------
export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed. Use POST." }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { context, question, history } = body || {};
  if (!context || typeof question !== "string" || !question.trim()) {
    return Response.json({ error: "Request must include 'context' (object) and 'question' (non-empty string)." }, { status: 400 });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // No key configured at all — use the fallback immediately, no network call.
  if (!anthropicKey && !openaiKey) {
    const text = ruleBasedFallback(context, question);
    return Response.json({ text, source: "fallback", usedFallback: true, reason: "No API key configured" });
  }

  // Prefer Anthropic if both happen to be set; otherwise use whichever exists.
  try {
    if (anthropicKey) {
      const text = await callAnthropic(anthropicKey, context, question, history);
      return Response.json({ text, source: "llm", provider: "anthropic" });
    }
    const text = await callOpenAI(openaiKey, context, question, history);
    return Response.json({ text, source: "llm", provider: "openai" });
  } catch (err) {
    console.error("Coach LLM call failed, falling back to rule-based:", err);
    const text = ruleBasedFallback(context, question);
    return Response.json({ text, source: "fallback", usedFallback: true, reason: err.message });
  }
};
