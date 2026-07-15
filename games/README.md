# Game engines

Each game should keep its mechanics in isolated handlers so changes to one game do not affect others.

## Client (`index.html`)

- `GAME_INIT_HANDLERS` — per-game starting `gameState`
- `GAME_SCORE_HANDLERS` — per-game scoring / turn logic (standard dart-pad games)
- X01 and Cricket use dedicated panels (`x01ApplyTurn`, `applyCricketVisit`, etc.)

When adding a game, register init + score handlers only for that game.

## Server (`server.js` + `games/server/`)

- `games/server/init-handlers.js` — per-game server `gameState` init
- X01 / Cricket / Golf Checkouts engines remain in `server.js` until split out

Server `shouldSwitchTurn`, `computeBotMove`, and game-over checks are still centralized; split those per game when you extend a mode.
