# Testing

Use these checks before a game night or after changing shared launcher, socket, or game-flow code.

## Quick Confidence

```bash
npm test
npm run test:e2e
```

`npm test` covers server and integration behavior. `npm run test:e2e` verifies that the host can launch games, players follow the host into games, and everyone returns to the menu cleanly.

## Host And Player Switching

```bash
npm run test:load:full:gauntlet
```

This is the best regression check for the Jackbox-style connection behavior. It cycles every game with six isolated test players, reconnects players, and checks host-return-to-menu behavior without mutating your real launcher settings.

## Frame Pacing

```bash
npm run test:perf
npm run test:perf:active
```

`test:perf` samples idle host screens for every game. `test:perf:active` drives active flows like spins, drawing, poker actions, tournament tapping, Trivia answers, Voting votes, Spyfall reveal, and Mafia night actions. The perf runner fails if average FPS drops below 55, a frame exceeds 100ms, a long task is detected, or any host/player page logs browser warnings, errors, page errors, or failed HTTP responses.

Focused active checks are also available:

```bash
npm run test:perf:drawing
npm run test:perf:poker
npm run test:perf:tournament
npm run test:perf:trivia
npm run test:perf:voting
npm run test:perf:spyfall
npm run test:perf:mafia
```

## Full Pass

```bash
npm run test:full
```

Run this after larger changes. It chains the integration suite, Playwright switching test, load gauntlet, idle perf sweep, and active perf sweep.

## Notes

The perf runner creates temporary launcher settings with eight preset names and a temporary stats file, so it does not depend on or alter your normal launcher configuration. Tournament perf temporarily limits the tournament to Tap Race for measurement and restores `Games/tournament/gameSettings.json` afterward.

The current recommendation is to keep optimizing the existing DOM/canvas implementation before considering Phaser. A Phaser migration would make sense only after a specific game becomes animation-heavy enough that its current renderer is the bottleneck.
