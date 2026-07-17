/**
 * Per-game initial state handlers (server).
 * Add or change a game here without touching other games' init logic.
 */
function createGameInitHandlers(deps) {
  const { generateHalveItTargets, initGolfCheckoutsState } = deps;
  return {
    'Halve-It': () => ({
      targets: generateHalveItTargets(),
      roundIdx: 0,
      playerRounds: [[], []],
      roundProgress: [
        { round: 0, throws: 0, hits: 0, pending: 0, total: 0, currentDarts: [] },
        { round: 0, throws: 0, hits: 0, pending: 0, total: 0, currentDarts: [] }
      ]
    }),
    'Golf Darts': () => ({
      holes: Array.from({ length: 18 }, (_, i) => i + 1),
      playerHoles: [0, 0],
      playerDarts: [[], []],
      playerHoleScores: [[], []],
      ballPos: [[50, 85], [50, 15]]
    }),
    'Golf Checkouts': (config) => initGolfCheckoutsState
      ? initGolfCheckoutsState(config || {})
      : {},
    'Football Darts': () => ({
      ballX: 50,
      goals: [0, 0],
      events: [],
      round: 0,
      possession: null,
      visitDarts: [0, 0],
      visitThrows: [[], []]
    })
  };
}

function initGameStateForGame(game, config, handlers, deps) {
  const fn = handlers[game];
  if (fn) return fn(config || {});
  if (deps.isX01Game(game)) return deps.initX01State(config || {}, game);
  if (deps.isCricketGame(game)) return deps.initCricketState(config || {}, game);
  if (game === 'Golf Checkouts') return deps.initGolfCheckoutsState(config || {});
  return {};
}

module.exports = { createGameInitHandlers, initGameStateForGame };
