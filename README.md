# StarCrew ✦

An AI agent that plans stargazing nights around Boston. You ask in plain language
("best clear, dark night this week within 2 hours of Cambridge?"), and StarCrew picks
the night, the dark-sky site and the observing window, shows how confident the
forecast is, and writes a message you can paste into your group chat.

**Live site:** https://sia-xie-july.github.io/StarCrew/

**Design principle: the LLM reasons, deterministic tools supply the facts.** Claude
decides which tools to call and how to explain the trade-offs; every number it states
comes from a tool result, and every recommendation links back to the tool calls behind it.

> Term project for MIT 1.125 Agentic Engineering (Fall 2026). Status: **midpoint**.
> The single-user planner works end to end; group coordination is next.

## Bring your own API key, no server

StarCrew is a static site. The agent loop, the tools and the API calls all run in the
visitor's browser, so there is no backend and no shared API key:

- Each visitor signs in with **their own** Anthropic API key, so every request is billed
  to their account. Get a key at <https://console.anthropic.com/settings/keys>.
- The key is checked on sign-in with a free Models API call (no tokens used).
- It stays in the browser (`sessionStorage`, or `localStorage` if "Remember on this
  device" is ticked) and is sent only to `api.anthropic.com`. "Sign out" deletes it.
- After each plan, the page shows how many tokens were billed to the key.
- No key? "Explore the forecast without a key" shows the free 7-night forecast table.

## Run it locally

Any static file server works. With Python:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>. The browser loads its libraries from the jsDelivr CDN
(pinned versions in the import map in `index.html`).

### Developer mode: free local testing with Ollama

[Ollama](https://ollama.com/) serves an Anthropic-compatible Messages API, so the same
SDK and agent loop can run against a local model at no cost. When the page is served
from `localhost` and Ollama is running with a tool-capable model (for example
`ollama pull qwen3:8b`), the sign-in screen shows **Use local model**. Local runs turn
thinking off and skip Claude-only options; the client also drops the Anthropic-specific
headers that Ollama's CORS rules reject. Small local models are slow (about 2 minutes per
plan on an 8B model) and sometimes skip `submit_plan`; the cards then fall back to the
forecast tool's ranking, and the page says so.

## Tests

```bash
npm install
npm test
```

Node's built-in test runner covers the astronomy (checked against published Moon phases
and twilight times), scoring, time zones, and the agent loop against a scripted fake
Claude API (no key or credit needed; the weather calls are real).

## How it works

```
Browser
  ├─ Claude API (visitor's key) ── tool runner loop
  │     calls tools ↓
  ├─ geocode ─ list_dark_sites ─ forecast_nights ─ site_night_detail ─ submit_plan
  │     │            │                 │
  │  Open-Meteo   curated site    Astronomy Engine (darkness, Moon)
  │  geocoding    list (12)       Open-Meteo GFS / ECMWF / ICON (cloud cover)
  └─ UI: pick cards → detail view with night timeline and the tool calls behind each pick
```

| Piece | File | What it does |
|---|---|---|
| Astronomy | `js/astronomy.js` | Samples each night every 10 min: astronomical darkness (Sun below −18°), Moon altitude and illumination → "usable" dark hours and windows |
| Weather | `js/weather.js` | One Open-Meteo request for all sites, hourly cloud cover from three models; mean over the usable hours; **confidence** from model agreement (spread ≤15 points high, ≤30 medium, else low) |
| Sites | `js/sites.js` | 12 curated dark sites in MA/NH with approximate Bortle class and notes; drive time is a straight-line estimate |
| Planner | `js/planner.js` | Scores every (night, site): usable hours × (1 − cloud) × darkness factor, plus a go / maybe / no-go verdict |
| Agent | `js/agent.js` | Claude Opus 5.5 by default (Sonnet 5.5 and Haiku 5.5 selectable) with the SDK tool runner, effort `medium`, server-side refusal fallback. Records every tool call; re-verifies each pick and attaches its sources |
| Time | `js/time.js` | America/New_York wall-clock conversions with the built-in `Intl` API |
| UI | `index.html`, `js/app.js`, `css/style.css` | Sign-in, live progress, pick cards, detail view, agent trace, free forecast table |

## Status and next steps

Done for the midpoint:
- Data tools for weather, astronomy and sites, with tests
- Single-user agent working end to end on the visitor's own key, fully in the browser
- Pick cards with a detail view: night timeline, cloud cover per model, model reasoning vs. tool facts, and the tool calls behind each pick

Next, before the final:
- Group coordination: each member's start point, free nights and car seats → one plan
- Day-of re-check that proposes a backup when the forecast changes
- ISS passes (CelesTrak) and a meteor-shower calendar
- Backtest: are picked nights clearer than random nights on past weather?

## Limitations

- Cloud forecasts are uncertain beyond 2–3 days; the confidence level is the honest signal.
- Drive times are rough estimates, not routing.
- Site darkness values are approximate and park access hours change; check before going.
- Covers the Boston area only.

## Credits

- [Open-Meteo](https://open-meteo.com/) forecast and geocoding APIs (CC BY 4.0)
- [Astronomy Engine](https://github.com/cosinekitty/astronomy) by Don Cross (MIT)
- [Anthropic Claude API](https://docs.anthropic.com/) and TypeScript/JavaScript SDK
- Light-pollution estimates from [lightpollutionmap.info](https://www.lightpollutionmap.info/)
- Code written with AI assistance (Claude Code).
