# Mini Games Tournament - Testing Guide

## Pre-Testing Setup

### 1. Start the Server

```bash
cd /Users/vo/Downloads/Games
node server.js
```

The server should start on port 3000 (or your configured port).

### 2. Access the Application

- **Host Screen**: Open `http://localhost:3000/tournament` in your browser
- **Player Screens**: Open `http://localhost:3000/tournament/player` in multiple browser tabs/windows or on mobile devices

**Pro Tip**: Use Chrome's Device Mode (F12 → Toggle device toolbar) to simulate multiple players on one computer.

---

## Testing Checklist

### Phase 1: Basic Connection & Lobby (15 minutes)

#### Test 1.1: Player Joining
- [ ] Open host screen
- [ ] Open 4 player screens
- [ ] Join with names: "Alice", "Bob", "Carol", "Dave"
- [ ] **Verify**: All 4 players appear in host's leaderboard
- [ ] **Verify**: Online indicators (🟢) show for all players
- [ ] **Verify**: All players see "Waiting for tournament to start"

#### Test 1.2: Lobby Settings
- [ ] On host: Open settings modal
- [ ] Change settings:
  - Tic Tac Toe: Wins needed = 2
  - Math Dash: Points to win = 13
  - Minesweeper: Bombs = 2
- [ ] **Verify**: Settings save (close and reopen modal)
- [ ] Uncheck 5 mini-games (leave only 5 enabled)
- [ ] **Verify**: Only checked games are enabled

#### Test 1.3: Player Reconnection
- [ ] Close one player's browser tab
- [ ] **Verify**: Host shows red indicator (🔴) for that player
- [ ] Reopen player tab and rejoin with same name
- [ ] **Verify**: Player reconnects successfully
- [ ] **Verify**: Green indicator returns

---

### Phase 2: Tournament Flow (20 minutes)

#### Test 2.1: Tournament Start
- [ ] On host: Click "START TOURNAMENT"
- [ ] **Verify**: Intro slides play (3 slides, auto-advance)
- [ ] **Verify**: Bracket visualization appears
- [ ] **Verify**: Players show "Waiting for your match..."

#### Test 2.2: First Round (Parallel Matches)
- [ ] **Verify**: 2 matches start simultaneously
- [ ] **Verify**: Each player sees their match screen
- [ ] **Verify**: Opponent name displays correctly
- [ ] **Verify**: Random game is selected from enabled games

#### Test 2.3: Elimination & Voting
- [ ] Play through 2 matches (let matches complete naturally)
- [ ] **Verify**: Eliminated players (losers) see spectator screen
- [ ] **Verify**: Eliminated players see voting interface
- [ ] **Verify**: Host shows voting status (who voted/who hasn't)
- [ ] Submit votes from both eliminated players
- [ ] **Verify**: Votes tally correctly
- [ ] **Verify**: Selected game is announced

#### Test 2.4: Finals (Showdown)
- [ ] Play through semi-finals
- [ ] **Verify**: "FINAL SHOWDOWN" screen appears on host
- [ ] **Verify**: Dramatic split-screen display shows both finalists
- [ ] **Verify**: 5-second countdown before match starts
- [ ] Play finals match
- [ ] **Verify**: Winner is declared

#### Test 2.5: Game Over
- [ ] **Verify**: All players see game over screen
- [ ] **Verify**: Winner sees "1st Place" with gold styling
- [ ] **Verify**: All placements are correct (2nd, 3rd/4th, 5th-8th)
- [ ] **Verify**: Host shows complete standings
- [ ] **Verify**: Lifetime scores updated in leaderboard

---

### Phase 3: Mini-Game Testing (60 minutes)

Test each mini-game individually by enabling only that game and running a 2-player tournament.

#### Game 1: Tap Race (5 min)
- [ ] Enable only "Tap Race"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Both players rapidly tap the TAP button
- [ ] **Verify**: Progress bar moves correctly (-100 to +100)
- [ ] **Verify**: Score counts display
- [ ] **Verify**: First to reach ±100 wins
- [ ] **Verify**: Winner/loser messages show correctly

#### Game 2: Cowboy Duel (5 min)
- [ ] Enable only "Cowboy Duel"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Wait for "FIRE!" signal, then tap quickly
- [ ] **Test**: Tap before signal (should = MISFIRE = lose)
- [ ] **Verify**: Round results show (win/lose/tie)
- [ ] **Verify**: First to 3 round wins
- [ ] **Verify**: Ties restart the round

#### Game 3: Tic Tac Toe (5 min)
- [ ] Enable only "Tic Tac Toe"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Take turns clicking grid cells
- [ ] **Verify**: X and O symbols display correctly
- [ ] **Verify**: Turn indicators show
- [ ] **Verify**: Win detection works (rows, columns, diagonals)
- [ ] **Verify**: Ties restart the round
- [ ] **Verify**: First to win configured rounds (default 3) wins match

#### Game 4: Math Dash (5 min)
- [ ] Enable only "Math Dash"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Answer math questions as fast as possible
- [ ] **Test**: Answer correctly (should increment score)
- [ ] **Test**: Answer incorrectly (should decrement score)
- [ ] **Verify**: Difficulty increases every 3 correct answers
- [ ] **Verify**: Questions show: one operation → two → three → parentheses
- [ ] **Verify**: First to reach target score (default 10) wins

#### Game 5: Whack-a-Mole (5 min)
- [ ] Enable only "Whack-a-Mole"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Tap popup targets quickly
- [ ] **Verify**: Max 3 targets appear simultaneously
- [ ] **Verify**: Targets disappear after duration
- [ ] **Verify**: Score increments on hit
- [ ] **Verify**: First to lead by 5+ points wins

#### Game 6: Connect Four (5 min)
- [ ] Enable only "Connect Four"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Take turns dropping pieces in columns
- [ ] **Verify**: Pieces fall to bottom of column
- [ ] **Verify**: Win detection (4 in a row: horizontal, vertical, diagonal)
- [ ] **Test**: Fill board without winner (should restart)
- [ ] **Verify**: Red vs Yellow colors display correctly

#### Game 7: Memory Sequence (10 min)
- [ ] Enable only "Memory Sequence"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Memorize emoji positions during reveal phase
- [ ] **Actions**: Select unique positions (not selected by opponent)
- [ ] **Test**: Select already-selected position (should = mistake)
- [ ] **Verify**: 2 consecutive mistakes = lose
- [ ] **Verify**: Board size increases on tie (3×3 → 4×4 → 5×5)
- [ ] **Verify**: Correct selections allow continued play

#### Game 8: Blackjack (10 min)
- [ ] Enable only "Blackjack"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Choose HIT or STAND
- [ ] **Verify**: Cards display correctly
- [ ] **Verify**: Hand values calculate correctly
- [ ] **Test**: Go over 21 (should = BUST = lose round)
- [ ] **Verify**: Dealer hits until 17+
- [ ] **Verify**: First to 3 round wins
- [ ] **Verify**: Ties don't count

#### Game 9: Battleship (10 min)
- [ ] Enable only "Battleship"
- [ ] Start tournament with 2 players
- [ ] **Actions**: Place 5 ships on 5×5 grid
- [ ] **Verify**: Can't place overlapping ships
- [ ] **Verify**: Both players must place before battle starts
- [ ] **Actions**: Take turns firing at coordinates
- [ ] **Verify**: Hit markers (💥) and miss markers (○) display
- [ ] **Verify**: Can't fire at same coordinate twice
- [ ] **Verify**: First to sink all 5 opponent ships wins

#### Game 10: Minesweeper (10 min)
- [ ] Enable only "Minesweeper"
- [ ] In settings: Set bombs = 2
- [ ] Start tournament with 2 players
- [ ] **Actions**: Select cell, choose CLEAR or DEFUSE
- [ ] **Test**: Clear safe tile (should switch turns)
- [ ] **Test**: Clear bomb (should lose instantly)
- [ ] **Test**: Defuse bomb (should gain point, continue playing)
- [ ] **Test**: Defuse safe tile (should lose instantly)
- [ ] **Verify**: Numbers show Manhattan distance to nearest bomb
- [ ] **Verify**: Player with most bombs defused wins
- [ ] **Verify**: Ties restart with new board

---

### Phase 4: Edge Cases & Stress Testing (20 minutes)

#### Test 4.1: Offline Player Handling
- [ ] Start tournament with 4 players
- [ ] During Round 1, close one player's browser (don't rejoin)
- [ ] **Verify**: Tournament continues normally
- [ ] **Verify**: Offline player's match proceeds
- [ ] **Verify**: Match completes with result
- [ ] Reopen player tab and rejoin
- [ ] **Verify**: Player sees current tournament state
- [ ] **Verify**: Player can vote (if eliminated)

#### Test 4.2: Voting with Offline Players
- [ ] Start tournament with 6 players
- [ ] After Round 1, 3 players eliminated
- [ ] Close one eliminated player's tab
- [ ] **Verify**: Host shows 2/3 votes received
- [ ] Wait indefinitely
- [ ] Reopen eliminated player tab
- [ ] Submit vote
- [ ] **Verify**: Voting completes and next round starts

#### Test 4.3: Different Player Counts
Test with:
- [ ] 2 players (1 round = instant finals)
- [ ] 4 players (2 rounds)
- [ ] 8 players (3 rounds)

**Verify** for each:
- [ ] Bracket generates correctly
- [ ] Correct number of rounds
- [ ] Placements assigned correctly

#### Test 4.4: Settings Persistence
- [ ] Change all settings in host modal
- [ ] Exit game completely (close all tabs)
- [ ] Restart server
- [ ] Reopen host screen
- [ ] **Verify**: All settings persist correctly

#### Test 4.5: Rapid Actions
- [ ] Start Tap Race
- [ ] Spam click TAP button extremely fast (100+ clicks)
- [ ] **Verify**: No crashes or errors
- [ ] **Verify**: Score updates correctly

---

### Phase 5: Mobile Testing (15 minutes)

#### Test 5.1: Mobile Player Experience
- [ ] Open player screen on actual mobile device
- [ ] **Verify**: Layout looks good in portrait mode
- [ ] **Verify**: All buttons are large enough to tap easily (44px+)
- [ ] Test each mini-game on mobile
- [ ] **Verify**: No zoom issues
- [ ] **Verify**: Tap targets work correctly

#### Test 5.2: Touch Interactions
For each game on mobile:
- [ ] Tap Race: Rapid tapping feels responsive
- [ ] Whack-a-Mole: Can hit targets quickly
- [ ] Grid Games: Can tap cells accurately
- [ ] Battleship: Can place ships and fire
- [ ] Minesweeper: Can select cells and actions

---

## Known Issues to Check

1. **Socket Reconnection**: If player disconnects during match, do they reconnect seamlessly?
2. **Race Conditions**: If both players complete actions simultaneously, does server handle correctly?
3. **Memory Leaks**: After 3+ tournaments, check browser memory usage
4. **Timer Cleanup**: Do all intervals/timeouts clear properly when games end?
5. **Cross-Browser**: Test on Chrome, Firefox, Safari, Mobile Safari

---

## Bug Reporting Template

When you find a bug, record:

```
**Bug**: [Brief description]
**Steps to Reproduce**:
1. [Step 1]
2. [Step 2]
3. [etc...]

**Expected**: [What should happen]
**Actual**: [What actually happened]
**Browser**: [Chrome 120, Firefox 121, etc.]
**Console Errors**: [Any JavaScript errors]
**Screenshot**: [If applicable]
```

---

## Performance Benchmarks

Record these metrics during testing:

- **Lobby Load Time**: ___ ms
- **Match Start Delay**: ___ ms
- **Action Response Time** (tap to UI update): ___ ms
- **4-Player Tournament Duration**: ___ minutes
- **8-Player Tournament Duration**: ___ minutes

---

## Success Criteria

✅ **Core Functionality**
- All 10 mini-games work correctly
- Tournament bracket progresses properly
- Voting system functions
- Winner determination is accurate

✅ **User Experience**
- No confusing states or dead-ends
- Clear feedback on all actions
- Offline players handled gracefully
- Mobile experience is smooth

✅ **Stability**
- No crashes or freezes
- No socket disconnection issues
- All timers and intervals clean up properly
- Memory usage remains stable

---

## Quick Test (5 minutes)

For rapid iteration during development:

1. Open host + 2 players
2. Start tournament
3. Play one complete match of any game
4. Verify winner declared correctly
5. Check console for errors

If this passes, do full testing suite.

---

## Automated Testing (Future)

Consider adding:
- Jest unit tests for game logic
- Playwright E2E tests for user flows
- Socket.io-client for simulated players
- Load testing with 16+ concurrent players

---

Happy Testing! 🎮

Report issues at: https://github.com/your-repo/issues
