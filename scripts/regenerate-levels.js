// Re-applies the current difficulty algorithm (mirrored from editor.html) to
// every levels/level-N.json. Use after tweaking the algorithm to rebake the
// shipped levels without opening the editor for each one.
//
// Run: node scripts/regenerate-levels.js

const fs = require('fs');
const path = require('path');

const LEVELS_DIR = path.join(__dirname, '..', 'levels');
const LEVEL_KEYS = ['level-1', 'level-2', 'level-3', 'level-4'];

function buildPairsByCategory(categoriesData) {
  const map = new Map();
  for (const c of (categoriesData || [])) {
    if (!c || typeof c.categoryId !== 'string') continue;
    const arr = [{ categoryId: c.categoryId, wordId: c.categoryId }];
    const words = Array.isArray(c.wordsIds) ? c.wordsIds : [];
    for (const w of words) arr.push({ categoryId: c.categoryId, wordId: String(w) });
    map.set(c.categoryId, arr);
  }
  return map;
}

function buildSequenceByDifficulty(pairsByCat, difficulty, slotsAmount) {
  const slots = Math.max(1, slotsAmount | 0);
  const profiles = {
    easy:     { maxOpen: Math.min(2, slots), chunkSize: 1 },
    normal:   { maxOpen: Math.min(4, slots), chunkSize: 1 },
    hard:     { maxOpen: Math.min(6, slots), chunkSize: 1 },
    veryhard: { maxOpen: slots,              chunkSize: 1 },
  };
  const p = profiles[difficulty] || profiles.normal;

  const catIds = Array.from(pairsByCat.keys());
  for (let i = catIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [catIds[i], catIds[j]] = [catIds[j], catIds[i]];
  }

  const cats = catIds.map(id => {
    const all = pairsByCat.get(id).slice();
    const head = all[0];
    const rest = all.slice(1);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    return { id, queue: [head, ...rest] };
  });

  const sequence = [];
  const active = [];
  let nextCatIdx = 0;
  const refill = () => {
    while (active.length < p.maxOpen && nextCatIdx < cats.length) {
      active.push(cats[nextCatIdx++]);
    }
  };
  refill();
  let activeIdx = 0;
  let chunkLeft = p.chunkSize;
  while (active.length > 0) {
    const cat = active[activeIdx];
    sequence.push(cat.queue.shift());
    chunkLeft--;
    if (cat.queue.length === 0) {
      active.splice(activeIdx, 1);
      refill();
      if (active.length === 0) break;
      if (activeIdx >= active.length) activeIdx = 0;
      chunkLeft = p.chunkSize;
    } else if (chunkLeft <= 0) {
      activeIdx = (activeIdx + 1) % active.length;
      chunkLeft = p.chunkSize;
    }
  }
  return sequence;
}

function ensureBoardHasAllCategories(sequence, boardCapacity) {
  if (boardCapacity >= sequence.length) return;
  const counts = new Map();
  for (let i = 0; i < boardCapacity; i++) {
    const c = sequence[i].categoryId;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  for (let stockIdx = boardCapacity; stockIdx < sequence.length; stockIdx++) {
    const pair = sequence[stockIdx];
    if (counts.has(pair.categoryId)) continue;
    let donorCat = null, donorCount = -1;
    for (const [c, n] of counts) if (n > donorCount) { donorCat = c; donorCount = n; }
    if (donorCount < 2) break;
    for (let boardIdx = boardCapacity - 1; boardIdx >= 0; boardIdx--) {
      if (sequence[boardIdx].categoryId === donorCat) {
        const evicted = sequence[boardIdx];
        sequence[boardIdx] = pair;
        sequence[stockIdx] = evicted;
        counts.set(donorCat, donorCount - 1);
        counts.set(pair.categoryId, 1);
        break;
      }
    }
  }
}

function assignSequenceToBoardAndStock(level, sequence) {
  const positions = [];
  level.stages.forEach((stage, sIdx) => {
    stage.tiles.forEach((_, tIdx) => {
      const t = stage.tiles[tIdx];
      positions.push({ sIdx, tIdx, z: stage.z, x: t.x, y: t.y });
    });
  });
  positions.sort((a, b) => (b.z - a.z) || (a.y - b.y) || (a.x - b.x));
  const totalTiles = positions.length;
  if (totalTiles === 0) throw new Error('No tiles on the board to apply pairs to.');
  if (totalTiles > sequence.length) {
    throw new Error(`Not enough pairs: ${sequence.length} pairs vs ${totalTiles} tiles.`);
  }
  ensureBoardHasAllCategories(sequence, totalTiles);
  for (let i = 0; i < totalTiles; i++) {
    const pos = positions[i];
    const p = sequence[i];
    level.stages[pos.sIdx].tiles[pos.tIdx].categoryId = p.categoryId;
    level.stages[pos.sIdx].tiles[pos.tIdx].wordId = p.wordId;
  }
  return sequence.slice(totalTiles).map(p => p.wordId);
}

function regenerateLevel(key) {
  const jsonPath = path.join(LEVELS_DIR, key + '.json');
  const jsPath = path.join(LEVELS_DIR, key + '.js');
  const level = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const pairsByCat = buildPairsByCategory(level.categories);
  if (pairsByCat.size === 0) throw new Error(`${key}: no usable categories embedded in JSON`);
  const sequence = buildSequenceByDifficulty(pairsByCat, level.difficulty, level.slotsAmount);
  level.stock = assignSequenceToBoardAndStock(level, sequence);

  const jsonText = JSON.stringify(level, null, 2);
  fs.writeFileSync(jsonPath, jsonText, 'utf8');

  const jsText =
    '// Auto-generated alongside ' + key + '.json by editor.html.\n' +
    '// Regenerated whenever you press "Download JSON + JS".\n' +
    '(function () {\n' +
    '  if (!window.MAHJONG_LEVELS) window.MAHJONG_LEVELS = {};\n' +
    '  window.MAHJONG_LEVELS[' + JSON.stringify(key) + '] = ' + jsonText + ';\n' +
    '})();\n';
  fs.writeFileSync(jsPath, jsText, 'utf8');

  const boardTiles = level.stages.reduce((n, s) => n + s.tiles.length, 0);
  const boardCats = new Set();
  for (const s of level.stages) for (const t of s.tiles) boardCats.add(t.categoryId);
  console.log(
    `${key}: ${level.difficulty}, slots=${level.slotsAmount}, ` +
    `board=${boardTiles} (cats: ${boardCats.size}/${pairsByCat.size}), ` +
    `stock=${level.stock.length}`
  );
}

for (const key of LEVEL_KEYS) regenerateLevel(key);
