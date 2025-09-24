# Flash-Lag Demo

Interactive web experiment that replicates the flash-lag illusion and a disappearing-dot variant. Participants watch a dot move left to right, then click where they believe the target was when a flash appeared (flash-lag mode) or where it vanished (disappearing mode). Results are stored until reset or reload and a leaderboard reveals the most accurate guessers.

**Live demo:** https://dgrignol.github.io/flashlag-demo/

## Features

- Two modes: classic flash-lag (flash at screen centre) and disappearing-dot (no flash, dot vanishes at selected offset).
- Adjustable parameters: motion speed, flash/disappearance offset, flash duration, offsets, dot radius, colours.
- Automatic scaling: canvas resizes to the viewport, keeping trials aligned.
- Immediate feedback: error visualization plus per-participant stats and a leaderboard.

## Running locally

```bash
npm install
npm run dev
```

The dev server starts at http://localhost:5173 (default). Changes hot-reload in the browser.

## Usage flow

1. Enter participant name.
2. Choose the desired mode and (optionally) tweak settings.
3. Start each trial, watch the moving dot, then click the location you perceived.
4. After three trials, review the average error or export the data.

## Technology

- Vite + React (canvas rendering for the stage)
- Tailwind CSS styles
- No backend—data persists in memory while the page is open.
