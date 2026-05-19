# Network-Based Party Games

A Jackbox-style local party game launcher built with Node.js, Express, and Socket.IO. One host runs the game board in a browser, and players join from phones or other devices on the same network.

## Games Included

| Game | Players | Description |
| --- | ---: | --- |
| Charades | 3-20 | Act out words and phrases across multiple game modes. |
| Jeopardy | 2-20 | Classic trivia game show with categories and point values. |
| Mafia | 6-20 | Social deduction game where players try to find the mafia. |
| Poker | 2-8 | Texas Hold'em style poker. |
| Spin the Wheel | 0-20 | Weighted wheel picker for random words and prompts. |
| Spyfall | 3-20 | Ask questions, find the spy, and protect the location. |
| Mini Games Tournament | 2-16 | Elimination tournament with 10 fast mini-games. |
| Trivia Party | 2-20 | Multiple question types with scoring and competition. |
| Truth or Dare | 2-20 | Classic truth-or-dare play with custom content and bottle spins. |
| Voting Game | 3-20 | Vote on which friend best fits each prompt. |

## Requirements

- Node.js
- npm
- Devices connected to the same local network for multiplayer play

## Quick Start

```bash
npm install
npm start
```

Open the host screen at:

```text
http://localhost:3000
```

Players can join from another device at:

```text
http://<host-ip-address>:3000/players
```

The launcher also displays connection details so players can join from the same network.

## Project Structure

```text
server.js              Main launcher server
index.html             Host launcher UI
player.html            Player launcher UI
Games/                 Individual party games
shared/                Shared game UI and player management helpers
tests/                 Integration, e2e, load, and performance checks
```

Each game folder includes a `game.json` manifest plus its host UI, player UI, and game server logic.

## Testing

Run the quick smoke and integration checks:

```bash
npm test
```

Run the Playwright host/player switching test:

```bash
npm run test:e2e
```

Run the larger pre-game-night regression pass:

```bash
npm run test:load:full:gauntlet
```

Run the full test chain:

```bash
npm run test:full
```

See [TESTING.md](TESTING.md) for the full testing guide.

## Runtime Data

Local settings, score files, generated test output, checkpoints, and dependencies are intentionally ignored by git. This keeps the repository focused on source code and game assets while allowing each host machine to keep its own game-night state.

## GitHub Description

Jackbox-style local network party game launcher with Charades, Trivia, Mafia, Spyfall, Poker, Truth or Dare, Voting Game, Jeopardy, Spin the Wheel, and a mini-games tournament.
