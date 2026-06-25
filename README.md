# Lone Star Park Betting Intelligence

A mobile-first, no-backend horse racing handicapping and betting intelligence tool. All data is stored in the browser's local storage — there is no server and no database.

## Run it locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually `http://localhost:5173`).

## Build for production

```bash
npm run build
```

Output goes to the `dist/` folder.

## Deploy to Netlify

1. Push this project to a GitHub repository.
2. In Netlify, choose "Add new site" → "Import an existing project" → connect the repo.
3. Netlify will detect the build settings automatically from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Deploy. No environment variables or backend setup are needed — this is a static site.

You can also drag-and-drop the built `dist/` folder directly onto Netlify's deploy page for a one-off deploy without connecting GitHub at all.

## Project structure

```
.
├── index.html          # Vite entry HTML
├── package.json
├── vite.config.js
├── netlify.toml         # Netlify build + SPA redirect config
└── src/
    ├── main.jsx         # mounts <App /> into #root
    ├── App.jsx          # the entire application (scoring engine, UI, state)
    └── styles.css       # all styling, imported by App.jsx
```

## Notes

- Requires Node.js 20.19+ or 22.12+ (Vite 8 requirement).
- No API keys, no backend, no external services required to run or deploy.
- Data persists in the browser via `localStorage` under the key `lsp_handicapper_v2`. Clearing site data/history for the deployed URL will erase saved race cards.
