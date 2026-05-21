// Solitaire solver. Given a level definition (same JSON shape as
// levels/level-*.json), determine whether it's solvable and count the number
// of distinct collection orderings that lead to a win.
//
// A "way" = a sequence of (tile, slot) drops covering every tile, respecting:
//   - board-tile blocking (a tile is blocked while any higher-z tile overlaps it)
//   - slot/category constraints (a word tile needs a slot already holding its
//     category; a category tile needs an empty slot)
//   - auto-clear (a slot frees when its category's word tiles are all collected)
//
// Stock manipulation (flips/recycles) is abstracted away: any stock tile can be
// exposed via enough flips/recycles, so it doesn't affect WHICH orderings exist.
// Min-moves is reported separately as a feasibility estimate.
//
// Empty slots are interchangeable, so dropping a category in any empty slot is
// one canonical choice. State hash sorts filled slots by catId.
'use strict';

(function () {
  const TILE_W = 4, TILE_H = 6;

  function buildSolverData(level) {
    const categoryIds = new Set();
    const wordToCategory = new Map();
    for (const c of (level.categories || [])) {
      categoryIds.add(c.categoryId);
      for (const w of (c.wordsIds || [])) wordToCategory.set(String(w), c.categoryId);
    }
    const inferCategoryId = (name) =>
      categoryIds.has(name) ? name : (wordToCategory.get(name) || null);

    const boardTiles = [];
    for (const stage of (level.stages || [])) {
      const z = Number.isFinite(stage.z) ? stage.z : 0;
      for (const t of (stage.tiles || [])) {
        const catId = String(t.categoryId ?? '');
        const wordId = String(t.wordId ?? '');
        if (!catId) continue;
        boardTiles.push({
          x: t.x | 0, y: t.y | 0, z,
          catId, wordId,
          isCategory: wordId === catId,
        });
      }
    }

    const stockTiles = [];
    for (const s of (level.stock || [])) {
      const word = String(s);
      const catId = inferCategoryId(word);
      if (!catId) continue;
      stockTiles.push({ catId, wordId: word, isCategory: word === catId });
    }

    const N = boardTiles.length;
    const blockerMask = new Array(N);
    for (let i = 0; i < N; i++) {
      const tile = boardTiles[i];
      let m = 0n;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const other = boardTiles[j];
        if (other.z <= tile.z) continue;
        if (!(other.x + TILE_W <= tile.x || tile.x + TILE_W <= other.x ||
              other.y + TILE_H <= tile.y || tile.y + TILE_H <= other.y)) {
          m |= 1n << BigInt(j);
        }
      }
      blockerMask[i] = m;
    }

    const totalsPerCat = new Map();
    const bump = (c) => totalsPerCat.set(c, (totalsPerCat.get(c) || 0) + 1);
    for (const t of boardTiles) if (!t.isCategory) bump(t.catId);
    for (const t of stockTiles) if (!t.isCategory) bump(t.catId);

    const numSlots = Math.max(1, level.slotsAmount | 0) || 6;

    return { boardTiles, stockTiles, blockerMask, totalsPerCat, numSlots };
  }

  function solveLevel(level, opts) {
    opts = opts || {};
    const data = buildSolverData(level);
    const N = data.boardTiles.length;
    const M = data.stockTiles.length;
    const allBoard = N === 0 ? 0n : ((1n << BigInt(N)) - 1n);
    const allStock = M === 0 ? 0n : ((1n << BigInt(M)) - 1n);

    const startTime = Date.now();
    const MAX_STATES = opts.maxStates || 200000;
    const MAX_TIME_MS = opts.maxTimeMs || 20000;
    const MAX_WAYS = BigInt(opts.maxWays || '1000000000000000');

    const cache = new Map();
    const stats = { explored: 0, hits: 0, capped: false, capReason: null };
    let foundOneSolution = null; // remember one winning ordering for "play through"

    function slotsKey(slots) {
      const filled = [];
      let empty = 0;
      for (const s of slots) {
        if (s) filled.push(s.catId + ':' + s.count);
        else empty++;
      }
      filled.sort();
      return filled.join('|') + '#' + empty;
    }

    function stateKey(boardCollected, stockPool, slots) {
      return boardCollected.toString(36) + '|' + stockPool.toString(36) + '|' + slotsKey(slots);
    }

    function isUnblocked(idx, boardCollected) {
      return (data.blockerMask[idx] & ~boardCollected) === 0n;
    }

    function findSlotForCat(slots, catId) {
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s && s.catId === catId) return i;
      }
      return -1;
    }

    function findFirstEmpty(slots) {
      for (let i = 0; i < slots.length; i++) if (!slots[i]) return i;
      return -1;
    }

    function applyDropToSlots(slots, tile) {
      if (tile.isCategory) {
        const idx = findFirstEmpty(slots);
        if (idx < 0) return null;
        const out = slots.slice();
        out[idx] = { catId: tile.catId, count: 0 };
        return out;
      }
      const idx = findSlotForCat(slots, tile.catId);
      if (idx < 0) return null;
      const out = slots.slice();
      const cur = out[idx];
      const newCount = cur.count + 1;
      const total = data.totalsPerCat.get(tile.catId) || 0;
      if (newCount >= total) out[idx] = null;
      else out[idx] = { catId: tile.catId, count: newCount };
      return out;
    }

    function ways(boardCollected, stockPool, slots, path) {
      if (boardCollected === allBoard && stockPool === 0n) {
        if (!foundOneSolution) foundOneSolution = path.slice();
        return 1n;
      }
      if (stats.capped) return 0n;
      if (stats.explored >= MAX_STATES) {
        stats.capped = true; stats.capReason = 'states'; return 0n;
      }
      if (Date.now() - startTime > MAX_TIME_MS) {
        stats.capped = true; stats.capReason = 'time'; return 0n;
      }

      const key = stateKey(boardCollected, stockPool, slots);
      const cached = cache.get(key);
      if (cached !== undefined) {
        stats.hits++;
        return cached;
      }
      stats.explored++;

      let total = 0n;

      for (let i = 0; i < N; i++) {
        if (total >= MAX_WAYS) break;
        const bit = 1n << BigInt(i);
        if (boardCollected & bit) continue;
        if (!isUnblocked(i, boardCollected)) continue;
        const tile = data.boardTiles[i];
        const newSlots = applyDropToSlots(slots, tile);
        if (!newSlots) continue;
        path.push({ src: 'board', idx: i, catId: tile.catId, wordId: tile.wordId });
        const w = ways(boardCollected | bit, stockPool, newSlots, path);
        path.pop();
        total += w;
        if (total >= MAX_WAYS) {
          total = MAX_WAYS;
          stats.capped = true;
          if (!stats.capReason) stats.capReason = 'ways';
        }
      }

      for (let i = 0; i < M; i++) {
        if (total >= MAX_WAYS) break;
        const bit = 1n << BigInt(i);
        if (!(stockPool & bit)) continue;
        const tile = data.stockTiles[i];
        const newSlots = applyDropToSlots(slots, tile);
        if (!newSlots) continue;
        path.push({ src: 'stock', idx: i, catId: tile.catId, wordId: tile.wordId });
        const w = ways(boardCollected, stockPool & ~bit, newSlots, path);
        path.pop();
        total += w;
        if (total >= MAX_WAYS) {
          total = MAX_WAYS;
          stats.capped = true;
          if (!stats.capReason) stats.capReason = 'ways';
        }
      }

      if (!stats.capped) cache.set(key, total);
      return total;
    }

    // Seed slot state from opts.initialSlots so the solver can pick up
    // mid-game. Each filled slot starts at count=0 in the virtual level
    // because totalsPerCat is derived from un-played tiles only, so a slot
    // auto-clears once the remaining word tiles for its category are dropped.
    const initSlots = new Array(data.numSlots).fill(null);
    if (Array.isArray(opts.initialSlots)) {
      for (let i = 0; i < data.numSlots; i++) {
        const s = opts.initialSlots[i];
        if (s && s.catId) initSlots[i] = { catId: s.catId, count: 0 };
      }
    }
    const initialWasteCount = Math.max(0, Math.min(M, (opts.initialWasteCount | 0)));
    const numWays = ways(0n, allStock, initSlots, []);
    const timeMs = Date.now() - startTime;

    const actualMoves = foundOneSolution
      ? simulateMovesCost(foundOneSolution, M, initialWasteCount)
      : null;

    return {
      numWays,
      solvable: numWays > 0n,
      capped: stats.capped,
      capReason: stats.capReason,
      statesExplored: stats.explored,
      cacheHits: stats.hits,
      timeMs,
      boardTilesCount: N,
      stockTilesCount: M,
      sampleSolution: foundOneSolution,
      movesBudget: level.movesCount | 0,
      initialWasteCount,
      actualMoves,
    };
  }

  // Replay a sample solution against the stock cycle model to count the real
  // moves required (flip/drag/recycle, not just one drop per stock tile).
  // The cycle is the list of stock indices 0..M-1 in level.stock order; initial
  // waste = first initialWasteCount of them, top = index initialWasteCount-1.
  // For each stock play, navigate from the current waste-top to the target:
  //   - if target on top:        1 drag.
  //   - if target in face-down stock: flip until exposed, drag.
  //   - if target buried in waste:   flush remaining stock, recycle, flip,
  //                                  drag. (Worst case; the solver enumerates
  //                                  alternative orderings to avoid this.)
  function simulateMovesCost(path, M, initialWasteCount) {
    const unplayed = [];
    for (let i = 0; i < M; i++) unplayed.push(i);
    let wasteEnd = Math.max(-1, Math.min(M - 1, initialWasteCount - 1));
    let moves = 0;
    for (const step of path) {
      if (step.src === 'board') { moves += 1; continue; }
      const cyclePos = unplayed.indexOf(step.idx);
      if (cyclePos < 0) continue;
      if (cyclePos === wasteEnd) {
        moves += 1;
        unplayed.splice(cyclePos, 1);
        wasteEnd -= 1;
      } else if (cyclePos > wasteEnd) {
        moves += (cyclePos - wasteEnd) + 1;
        unplayed.splice(cyclePos, 1);
        wasteEnd = cyclePos - 1;
      } else {
        const flushFlips = (unplayed.length - 1) - wasteEnd;
        moves += flushFlips + 1 + (cyclePos + 1) + 1;
        unplayed.splice(cyclePos, 1);
        wasteEnd = cyclePos - 1;
      }
    }
    return moves;
  }

  // Difficulty label is a rough heuristic. Fewer ways => harder. A capped
  // result means the search hit its budget before exhausting the tree, so the
  // actual count is at least the reported number — almost always Easy in that
  // case (the tree is too big to enumerate).
  function difficultyLabel(result) {
    if (!result.solvable) return 'Unsolvable';
    const w = result.numWays;
    if (result.capped) return 'Easy';
    if (w >= 1000000n) return 'Easy';
    if (w >= 10000n) return 'Normal';
    if (w >= 100n) return 'Hard';
    return 'Very Hard';
  }

  function formatBigInt(n) {
    const s = n.toString();
    if (s.length <= 18) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    // Scientific for huge numbers
    const exp = s.length - 1;
    const mantissa = s[0] + '.' + s.slice(1, 4);
    return mantissa + 'e' + exp;
  }

  function formatWays(result) {
    if (!result.solvable) return '0';
    const base = formatBigInt(result.numWays);
    return result.capped ? '≥ ' + base : base;
  }

  // When the solver has a sample solution, report the moves it actually needs
  // (board drops + accurate stock cycle navigation: flips, drags, recycles).
  // Falls back to the naive board + 2*stock estimate when no sample is available.
  function minMovesEstimate(result) {
    if (result && typeof result.actualMoves === 'number') return result.actualMoves;
    return result.boardTilesCount + 2 * result.stockTilesCount;
  }

  if (typeof window !== 'undefined') {
    window.MahjongSolver = {
      solveLevel,
      difficultyLabel,
      formatWays,
      formatBigInt,
      minMovesEstimate,
      simulateMovesCost,
    };
  }
})();
