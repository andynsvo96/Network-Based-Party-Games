# Bug Report: Spin the Wheel & Tournament Games
## Connection Handler Scan Results

**Date**: 2026-02-10
**Scanned Against**: Charades & Trivia (reference implementations)

---

## Executive Summary

Scanned both games for bugs and issues related to host/player connection handling. **5 critical bugs confirmed** that prevent proper reconnection behavior and could corrupt game state.

### Critical Bugs (Must Fix Immediately)
1. ✅ **Tournament: Bracket validation allows invalid player counts** (6, 10, 12, 14 players)
2. ✅ **Tournament: Mini-game instances hold stale socket IDs** after player reconnection
3. ✅ **Spin the Wheel: Missing reconnection state sync** for INTRO and GAME_OVER phases
4. ✅ **Tournament: Missing reconnection state sync** for all non-LOBBY phases
5. ✅ **Both Games: Offline player UI doesn't update** on reconnection (related to #3 and #4)

---

## Detailed Bug Analysis

### Bug #1: Tournament Bracket Validation (CRITICAL)

**File**: [tournament/server.js:290-300](Games/tournament/server.js#L290-L300)

**Issue**: Validation only checks for even numbers, not powers of 2.

**Code**:
```javascript
// Line 291: Only rejects ODD numbers
if (playerCount % 2 !== 0) {
  throw new Error('Tournament requires even number of players');
}

// Line 300: Assumes power of 2
const totalRounds = Math.log2(playerCount); // Non-integer for 6, 10, 14!
```

**Impact**:
- Allows 6, 10, 12, 14 players to start tournament
- `Math.log2(6) = 2.585...` (non-integer)
- Line 327: `Math.pow(2, 0.585) = 1.5` creates invalid bracket structure
- Tournament becomes unplayable

**Test Case**:
1. Join 6 players
2. Start tournament
3. Bracket generation creates corrupted structure

**Fix Needed**:
```javascript
// Check if power of 2
if (playerCount % 2 !== 0 || Math.log2(playerCount) % 1 !== 0) {
  throw new Error('Tournament requires power-of-2 players (2, 4, 8, or 16)');
}
```

---

### Bug #2: Tournament Mini-Game Stale Socket IDs (CRITICAL)

**Files**:
- [tournament/server.js:514-523](Games/tournament/server.js#L514-L523)
- [minigames/minigame-base.js:208-215](Games/tournament/minigames/minigame-base.js#L208-L215)

**Issue**: Mini-game instances store player socket IDs at construction time and never update them.

**Flow**:
1. **Match starts** (lines 514-523): Mini-game gets `player1.socketId` and `player2.socketId`
2. **Player disconnects** (line 1264): `player.socketId = null`
3. **Player reconnects** (line 991): `player.socketId = NEW_SOCKET_ID`
4. **Mini-game still has OLD socketId**: `this.player1.socketId` is stale!

**Code** (minigame-base.js):
```javascript
// Line 209-212: Uses stale socketId from construction
getPlayerSocketId(playerKey) {
  if (playerKey === this.player1.key) {
    return this.player1.socketId;  // ❌ STALE!
  } else if (playerKey === this.player2.key) {
    return this.player2.socketId;  // ❌ STALE!
  }
  return null;
}
```

**Impact**:
- Player disconnects during mini-game
- Player reconnects
- Mini-game events sent to old (disconnected) socket
- Player cannot interact with mini-game
- Player appears frozen

**Test Case**:
1. Start tournament with 2 players
2. Begin mini-game match
3. Disconnect one player
4. Reconnect same player
5. Mini-game cannot communicate with reconnected player

**Fix Needed**:
Option A: Query parent tournament for current socketId instead of caching
Option B: Add socket update notification mechanism to mini-games

---

### Bug #3: Spin the Wheel Missing Reconnection State Sync (CRITICAL)

**File**: [spin-the-wheel/server.js:386-399](Games/spin-the-wheel/server.js#L386-L399)

**Issue**: Reconnecting players only receive basic `gameState` object. Phase-specific events not sent.

**Current Code**:
```javascript
// Lines 386-394: Only sends generic gameState
socket.emit('gameState', {
  phase: gameState.phase,
  currentPreset: gameState.currentPreset,
  // ... basic fields only
});

// Lines 397-399: Only handles MAIN_GAME during player's turn
if (gameState.phase === PHASES.MAIN_GAME && gameState.currentTurnKey === playerKey) {
  socket.emit('yourTurn', { canSpin: true });
}
// ❌ No handling for INTRO or GAME_OVER phases!
```

**Missing State Sync**:

| Phase | What's Missing | Impact |
|-------|---------------|--------|
| INTRO | `introPhase` event not sent | Player doesn't see intro slides |
| GAME_OVER | `lastGameOverPayload` not sent | Player doesn't see final results |

**Cached Payloads Exist But Not Used**:
- Line 60: `let lastGameOverPayload = null;` declared
- Line 660-665: Payload cached and emitted on game over
- ❌ **Never sent to reconnecting players!**

**Test Cases**:
1. **INTRO Reconnect**: Disconnect during lobby, host starts game (enters INTRO), player reconnects → sees nothing
2. **GAME_OVER Reconnect**: Disconnect during game, game ends, player reconnects → doesn't see results

**Reference**: Compare to [trivia/server.js:929-998](Games/trivia/server.js#L929-L998) `syncPlayerState` function

---

### Bug #4: Tournament Missing Reconnection State Sync (CRITICAL)

**File**: [tournament/server.js:1036-1041](Games/tournament/server.js#L1036-L1041)

**Issue**: Only syncs state if in LOBBY phase. All other phases get NO state sync!

**Current Code**:
```javascript
// Lines 1036-1041: Only handles LOBBY!
if (gameState.phase === PHASES.LOBBY) {
  socket.emit('phase:update', {
    phase: gameState.phase,
    leaderboard: getLeaderboard()
  });
}
// ❌ No handling for other 6 phases!
```

**Missing State Sync**:

| Phase | What's Missing | Impact |
|-------|---------------|--------|
| INTRO | `lastIntroPayload` not sent (cached line 399!) | Player sees nothing |
| BRACKET | Bracket display state not sent | Player doesn't see bracket |
| MINI_GAME | `match:start` event not resent | Player doesn't know which game they're in |
| ROUND_COMPLETE | Round results not sent | Player misses results |
| SHOWDOWN | Showdown intro not sent | Player misses final match setup |
| VOTING | `voting:start` not resent (line 738) | Eliminated players can't vote! |
| GAME_OVER | `lastGameOverPayload` not sent (cached line 874!) | Player doesn't see final standings |

**Cached Payloads Exist But Not Used**:
- Line 118-120: Three payloads declared
- Line 399: `lastIntroPayload` cached
- Line 874: `lastGameOverPayload` cached
- ❌ **Never sent to reconnecting players!**

**Test Cases**:
1. **Mini-Game Reconnect**: Player in match disconnects, reconnects → doesn't see mini-game UI
2. **Voting Reconnect**: Eliminated player disconnects during voting, reconnects → can't vote (game hangs!)
3. **Game Over Reconnect**: Disconnect before finals, reconnect after tournament ends → doesn't see standings

---

### Bug #5: Offline Player UI Doesn't Update (CRITICAL)

**Related To**: Bugs #3 and #4

**Issue**: When a player is offline (e.g., at main menu/disconnected) and the game progresses to a new phase, reconnecting doesn't update their UI to match current game state.

**User's Requirement**:
> "If an offline player reconnects, make sure their player UI automatically updates to whatever the current status of the game is (like if they were at the main menu when they disconnected and return while the game is in session, their UI obviously should update to the current game session and not back in the main menu)"

**Current Behavior**:

**Spin the Wheel**:
- ✅ LOBBY → LOBBY: Works
- ✅ LOBBY → MAIN_GAME (during player's turn): Works (line 397-399)
- ✗ LOBBY → INTRO: Broken (no introPhase event)
- ✗ LOBBY → MAIN_GAME (not player's turn): Partial (gets gameState but no phase event)
- ✗ LOBBY → GAME_OVER: Broken (no lastGameOverPayload)

**Tournament**:
- ✅ LOBBY → LOBBY: Works
- ✗ LOBBY → ANY OTHER PHASE: Completely broken (no state sync at all!)

**Test Scenario**:
1. Player joins game lobby
2. Player disconnects (closes browser tab)
3. Host starts game
4. Game progresses through phases
5. Player reconnects
6. **Expected**: Player UI shows current game phase
7. **Actual**: Player UI stuck on old state

---

## Additional Findings (Medium Priority)

### Socket Mapping Race Condition (Spin the Wheel)

**File**: [spin-the-wheel/server.js:283-310, 323-366](Games/spin-the-wheel/server.js#L283-L366)

**Issue**: Auto-host assignment on connection may create stale mappings during rapid reconnects.

**Observation**: Line 327 checks for duplicate registration, but timing of old socketId cleanup may be off during rapid reconnects. Needs stress testing.

---

### Match Completion Race Condition (Tournament)

**File**: [tournament/server.js:549-596](Games/tournament/server.js#L549-L596)

**Issue**: No guard against mini-game calling `onComplete` callback multiple times.

**Code**:
```javascript
// Line 525-527: Callback can be called multiple times
onComplete: (winnerKey) => {
  handleMatchComplete(match.matchId, winnerKey);
}

// Line 549: No check if match already completed
function handleMatchComplete(matchId, winnerKey) {
  // Could advance bracket twice!
```

**Fix**: Add completion flag check at start of `handleMatchComplete`.

---

### Eliminated Player Status Not Synced (Tournament)

**File**: [tournament/server.js:988-1030](Games/tournament/server.js#L988-L1030)

**Issue**: Reconnecting eliminated players don't receive their elimination status.

**Code**:
```javascript
// Line 1014-1016: New player created with isEliminated: false
// Line 988-993: Reconnecting player doesn't get elimination state in response
if (callback) {
  callback({
    ok: true,
    playerKey: playerKey,
    reconnected: isReconnecting,
    phase: gameState.phase
    // ❌ Missing: isEliminated, placement, eliminatedRound
  });
}
```

**Impact**: Reconnecting eliminated player doesn't see their placement or that they're out of the tournament.

---

## Intentional Design (Not Bugs)

These behaviors are **working as intended** per user requirements:

### ✅ Game Waits for Offline Players

**Spin the Wheel**:
- Lines 215-221: Game waits for offline player during their turn
- Lines 814-818: Re-emits waiting message

**Tournament**:
- Lines 775: Voting waits for all eliminated players (even offline)

**Intentional**: Games pause until offline players reconnect, allowing them to resume. This is the desired behavior.

---

## Comparison with Reference Implementations

### Trivia Game (Reference Pattern)

**syncPlayerState Function** ([trivia/server.js:929-998](Games/trivia/server.js#L929-L998)):
```javascript
function syncPlayerState(socket, playerKey) {
  const player = players.get(playerKey);
  if (!player) return;

  switch (gamePhase) {
    case PHASES.LOBBY:
      socket.emit('lobbyState', { ... });
      break;
    case PHASES.INTRO:
      socket.emit('introPhase', getIntroSlides());
      break;
    case PHASES.QUESTION:
      // Sends current question state
      break;
    case PHASES.REVEAL:
      if (lastRevealPayload) {
        socket.emit('revealAnswer', lastRevealPayload);  // ✅ Uses cached payload
      }
      break;
    case PHASES.GAME_OVER:
      if (lastGameOverPayload) {
        socket.emit('gameOver', lastGameOverPayload);  // ✅ Uses cached payload
      }
      break;
  }
}
```

**Key Pattern**:
- Switch on current phase
- Send phase-specific events
- Use cached payloads for completed states

### Charades Game (Reference Pattern)

**Offline Player Resume** ([charades/server.js:2354-2362](Games/charades/server.js#L2354-L2362)):
```javascript
// If this player was being waited on, resume their turn
if (gameState.waitingForOfflinePlayer === key) {
  gameState.waitingForOfflinePlayer = null;
  setupPictionaryRound();  // ✅ Auto-resumes game
}
```

**Key Pattern**: Track waiting state and auto-resume when offline player reconnects.

---

## Recommended Fixes

### Priority 1: Critical Bugs

1. **Tournament Bracket Validation**
   - File: [tournament/server.js:291](Games/tournament/server.js#L291)
   - Change: Add power-of-2 check
   - Estimated effort: 5 minutes

2. **Tournament Mini-Game Socket Update**
   - Files: [tournament/server.js:991](Games/tournament/server.js#L991), minigames/minigame-base.js
   - Change: Add socket update mechanism to mini-games
   - Estimated effort: 1-2 hours

3. **Spin the Wheel syncPlayerState Function**
   - File: [spin-the-wheel/server.js:386-399](Games/spin-the-wheel/server.js#L386-L399)
   - Change: Add phase-specific sync function (pattern from trivia)
   - Estimated effort: 1 hour

4. **Tournament syncPlayerState Function**
   - File: [tournament/server.js:1036-1041](Games/tournament/server.js#L1036-L1041)
   - Change: Add comprehensive phase-specific sync function
   - Estimated effort: 2-3 hours

### Priority 2: Medium Issues

5. **Match Completion Guard**
   - File: [tournament/server.js:549](Games/tournament/server.js#L549)
   - Change: Add completion flag check
   - Estimated effort: 15 minutes

6. **Eliminated Player Status Sync**
   - File: [tournament/server.js:1030](Games/tournament/server.js#L1030)
   - Change: Include elimination state in callback
   - Estimated effort: 15 minutes

---

## Testing Checklist

After fixes are implemented, test these scenarios:

### Reconnection Tests
- [ ] Disconnect during LOBBY, reconnect → see lobby
- [ ] Disconnect during INTRO, reconnect → see intro slides
- [ ] Disconnect during MAIN_GAME (spin the wheel), reconnect → see current turn state
- [ ] Disconnect during MINI_GAME (tournament), reconnect → see mini-game UI
- [ ] Disconnect during VOTING (tournament), reconnect → see voting UI
- [ ] Disconnect during GAME_OVER, reconnect → see final results

### Offline Player Tests
- [ ] Player offline during their turn → game waits
- [ ] Offline player reconnects → game auto-resumes
- [ ] Offline voter reconnects → can vote
- [ ] Player disconnects from main menu, game starts, player reconnects → UI updates to game

### Bracket Validation Tests
- [ ] Try to start tournament with 3 players → rejected
- [ ] Try to start tournament with 5 players → rejected
- [ ] Try to start tournament with 6 players → rejected (CURRENTLY BROKEN)
- [ ] Try to start tournament with 7 players → rejected
- [ ] Try to start tournament with 10 players → rejected (CURRENTLY BROKEN)
- [ ] Start tournament with 2 players → works
- [ ] Start tournament with 4 players → works
- [ ] Start tournament with 8 players → works
- [ ] Start tournament with 16 players → works

### Mini-Game Reconnection Tests
- [ ] Disconnect during mini-game → player marked offline
- [ ] Reconnect during same mini-game → can continue playing
- [ ] Verify mini-game events reach reconnected player

---

## Conclusion

Both games have **critical connection handling bugs** that prevent players from reconnecting properly. The most severe issues are:

1. Tournament accepts invalid player counts that corrupt bracket generation
2. Mini-game instances can't communicate with reconnected players
3. Reconnecting players don't receive current game state (UI stays frozen)

These bugs directly violate the user's requirement that "offline player UI should automatically update to current game status on reconnection."

**Recommendation**: Implement `syncPlayerState` function in both games following the trivia/charades pattern, fix bracket validation, and add mini-game socket update mechanism.
