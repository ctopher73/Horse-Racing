# The Horse Handicapper

A premium, mobile-first horse racing handicapping and betting intelligence app, with multi-card support, a personalized AI assistant ("The Horse Handicapper AI"), and a fully swappable data-provider architecture in place for future live racing data. Race-card data and user preferences stay entirely in browser local storage — there is no database.

## What's in this version

- **Branding** — renamed from the earlier prototype to The Horse Handicapper, with a horseshoe-and-horse-head logo, a premium dark-green/black/gold/white color system, and a polished dashboard with at-a-glance stats (race count, bet signals, skip flags, horse count).
- **Multiple race cards** — create, switch between, duplicate, and delete cards for any track/date combination. No fixed track or date.
- **The Horse Handicapper AI** — a chat interface with conversation history, suggested prompts, a **Today's Briefing** at the top (best bet, best value, vulnerable favorite, races to skip, bankroll exposure, Pick 3/4 idea), and "Ask AI" buttons on every race card, race-detail view, and horse row.
- **Real AI connection, with automatic fallback** — `/netlify/functions/coach.js` calls Anthropic's Claude or OpenAI's API (whichever key is configured), using the active card's full context: scores, sub-scores, pace projections, odds history, bankroll settings, bet/pass recommendations, smart-money flags, and (if enabled) the user's saved preferences. If no key is configured or the call fails, it falls back to a deterministic rule-based engine automatically — the chat never shows an error.
- **User profile & preferences** — preferred tracks, default bankroll, favorite bet types, risk tolerance, and an AI answer-style/personalization toggle, reachable via the gear icon in the header. Saved to their own localStorage key, independent of card data. The AI references these directly (e.g. noting when the active card's track is one of your preferred tracks, or shifting bankroll-exposure framing based on risk tolerance) whenever the "use my preferences" toggle is on.
- **CSV upload and manual entry** — unchanged, still the two ways to get race data into a card.
- **Full scoring/bankroll engine** — unchanged: speed/form, pace fit, class/surface/distance, trainer/jockey (win% + ROI), workouts/layoff, odds value, Kelly Criterion bet sizing.
- **Odds tracking** — manual snapshot capture, steam/drift detection, smart-money heuristic.
- **Lightweight polish** — hover/active states on buttons and cards, a modal slide-up entrance animation, empty-state illustrations, and responsive grid layouts for tablet/desktop.

## Run it locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually `http://localhost:5173`). The Horse Handicapper AI works in fallback (rule-based) mode out of the box — no setup required. To test the real AI connection locally, use the Netlify CLI (`netlify dev`) instead of plain `vite dev`, with environment variables set as described below.

## Build for production

```bash
npm run build
```

Output goes to the `dist/` folder.

## Connecting a real AI provider (optional)

The app works fully without this — The Horse Handicapper AI just runs in rule-based mode. To connect a real LLM:

1. In Netlify, go to **Site configuration → Environment variables**.
2. Add **one** of the following (if both are set, Anthropic is used):
   - `ANTHROPIC_API_KEY` — a Claude API key from [console.anthropic.com](https://console.anthropic.com)
   - `OPENAI_API_KEY` — an API key from [platform.openai.com](https://platform.openai.com)
3. Redeploy. No frontend code or build settings need to change.

The frontend never sees these keys. Every chat message goes to `/netlify/functions/coach.js`, which makes the actual API call server-side.

## Deploy to Netlify

1. Push this project to a GitHub repository.
2. In Netlify, choose "Add new site" → "Import an existing project" → connect the repo.
3. Netlify detects the build settings automatically from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
4. (Optional) Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` as described above. **No environment variables are required for the app to run** — without them, the AI runs in rule-based mode automatically.
5. Deploy.

**Note on `netlify.toml`:** the SPA catch-all redirect (`/* → /index.html`) is listed *after* an explicit redirect for `/.netlify/functions/*`. Netlify's redirect engine is first-match-wins, and on some configurations a blanket SPA rule can shadow function routes. Keep the functions redirect first if you edit this file.

## Project structure

```
.
├── index.html                  # Vite entry HTML
├── package.json
├── vite.config.js
├── netlify.toml                  # Netlify build config + redirects
├── netlify/
│   └── functions/
│       ├── coach.js               # The Horse Handicapper AI backend — calls Anthropic/OpenAI, falls back to rule-based
│       └── racecard.js            # Scaffolded only, NOT wired up — see "Live data" below
└── src/
    ├── main.jsx                    # mounts <App /> into #root
    ├── App.jsx                      # UI layer: all screens/components, root app state
    ├── styles.css                   # all styling, imported by App.jsx
    └── lib/
        ├── utils.js                  # tiny shared helpers (id generation, date formatting, etc.)
        ├── scoring.js                # pure scoring engine — speed/pace/class/trainer-jockey/odds-value,
        │                             # Kelly Criterion, chaos/skip-race detection, confidence, bet recs
        ├── coach.js                  # AI engine — context building, proactive insights, rule-based
        │                             # question routing, the LLM-calling provider with fallback
        ├── storage.js                # data model (cards/races/horses), localStorage persistence + schema
        │                             # migration, CSV import/export, user preferences persistence
        └── providers.js              # Entries/Odds/Results/Scratches provider interfaces (see below)
```

This is a real module split, not just file organization — `App.jsx` contains UI only. All scoring, AI, and data-model logic lives in `src/lib/` and has no dependency on React.

## About The Horse Handicapper AI

The AI does not have its own opinion about any race. Every fact in its answers — and every fact an LLM is given when a real provider is connected — comes from the exact same `buildRaceSummary()` output that powers the Races and Bankroll tabs. Preferences (when enabled) shape *framing only*: which track gets mentioned, which bet types get surfaced first, how cautious or aggressive the bankroll-exposure language is, and how verbose the answer is. They never change a score, a recommendation, or a fact.

**Architecture, for future changes:**
- `buildCoachContext(card, bankroll, preferences)` in `src/lib/coach.js` assembles everything the AI can reason about, including the user's preferences object.
- `serializeCoachContext()` flattens that into the compact JSON sent to the Netlify Function. Preferences are only included in this payload when the user has the "use my preferences" toggle on — turning it off means the field is omitted entirely, not just zeroed out.
- `CoachProviderInterface` documents the provider contract (`answerQuestion`, `generateInsights`). `llmCoachProvider` (calls the function, falls back on any failure) is the default; `ruleBasedCoachProvider` is its fallback and can also be used directly if you want to disable network calls entirely.
- Proactive insights (Today's Briefing and the full insights grid) are **always** rule-based, even when a real LLM is connected — they're meant to be instant, not dependent on LLM latency.

## Live data: provider interfaces are complete, but nothing is connected

Per design, this version does **not** connect to any live racing-data API. What it does include is a finished, swappable interface layer (`src/lib/providers.js`) for four separate concerns:

- **Entries** — race/field data (who's running, post positions, etc.)
- **Odds** — morning line / live odds updates
- **Results** — finish order once a race is official
- **Scratches** — which horses are scratched

Each is its own interface so a real deployment could mix providers (e.g. entries from one vendor, live odds from a tote feed) without coupling them together. All four are currently satisfied by `manualProvider` (and its four split equivalents), which does nothing — the person typing data into the app is the data source. `racecard.js` remains scaffolded from an earlier pass as a reference for the "call a vendor API server-side, never from the browser" pattern, but is not invoked by the frontend.

When a provider is ready to connect, the integration point is swapping `activeEntriesProvider` / `activeOddsProvider` / `activeResultsProvider` / `activeScratchesProvider` in `providers.js` for real implementations — no other file should need to change.

## Notes

- Requires Node.js 20.19+ or 22.12+ (Vite 8 requirement).
- No API keys are required to run or deploy this app.
- Card/race data persists under the localStorage key `horse_handicapper_v3`. User preferences persist separately under `horse_handicapper_preferences_v1`. The app automatically migrates card data forward from all prior schema versions and app names (`lsp_handicapper_v3`, `lsp_handicapper_v2`, `lsp_handicapper_v1`) if found.
- Conversation history in the AI tab is per-session only (resets on page reload) — it is not persisted to localStorage.

## Changelog

### This release — production-polish pass
- **Rebrand:** renamed the app to The Horse Handicapper; designed and shipped a horseshoe-and-horse-head logo; renamed the AI assistant to The Horse Handicapper AI throughout the UI, system prompt, and code comments.
- **Visual design:** new premium dark-green/black/gold/white color palette with elevation shadows and gold gradients; polished dashboard with an at-a-glance stats strip; empty-state illustrations (races, horses, cards, chat); lightweight hover/active/transition polish on buttons, cards, and tab navigation; modal slide-up entrance animation; responsive grid layouts for tablet (640px+) and desktop (1024px+) breakpoints.
- **User profile & preferences (new):** preferred tracks, default bankroll, favorite bet types, risk tolerance, and AI answer-style settings, persisted independently in localStorage and wired into both the rule-based and LLM-backed AI advice.
- **Codebase refactor:** split the original single-file `App.jsx` (3,200+ lines) into `src/lib/scoring.js`, `src/lib/coach.js`, `src/lib/storage.js`, `src/lib/providers.js`, and `src/lib/utils.js`, leaving `App.jsx` as a UI-only layer. Removed duplicate CSS rules and dead styles found during the split.
- **Provider architecture (Phase 5):** split the single combined data-provider interface into four independent interfaces — Entries, Odds, Results, Scratches — each separately swappable, each currently satisfied by a no-op manual provider. No live API is connected.
- **Bug fixes found during this pass:** fixed a crash (`analyzeLayoff is not defined`) introduced during the module refactor that broke the "Add horse" form entirely; fixed a blank/broken-looking dashboard header on a brand-new install caused by an empty default track name; removed several track-specific placeholder strings left over from the app's original single-track prototype; removed duplicate CSS rules (`.race-card` was defined twice) and a redundant `prefers-reduced-motion` media query.
