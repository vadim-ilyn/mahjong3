// Re-applies the current difficulty algorithm (mirrored from editor.html) to
// every levels/level-N.json. Use after tweaking the algorithm to rebake the
// shipped levels without opening the editor for each one.
//
// Run: node scripts/regenerate-levels.js

const fs = require('fs');
const path = require('path');
const { discoverLevelKeys, buildBundle } = require('./build-manifest');

const LEVELS_DIR = path.join(__dirname, '..', 'levels');
const LEVEL_KEYS = discoverLevelKeys();

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

function buildSequenceByDifficulty(pairsByCat, difficulty, slotsAmount, boardCapacity) {
  const slots = Math.max(1, slotsAmount | 0);
  const profiles = {
    easy:     { maxOpen: Math.min(2, slots), chunkSize: 1, jokerDeferRatio: 0    },
    normal:   { maxOpen: Math.min(4, slots), chunkSize: 1, jokerDeferRatio: 0.2  },
    hard:     { maxOpen: Math.min(6, slots), chunkSize: 1, jokerDeferRatio: 0.45 },
    veryhard: { maxOpen: slots,              chunkSize: 1, jokerDeferRatio: 0.7  },
  };
  const p = profiles[difficulty] || profiles.normal;

  const catIds = Array.from(pairsByCat.keys());
  for (let i = catIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [catIds[i], catIds[j]] = [catIds[j], catIds[i]];
  }

  const numDeferred = Math.floor(catIds.length * p.jokerDeferRatio);
  const cats = catIds.map((id, idx) => {
    const all = pairsByCat.get(id).slice();
    const head = all[0];
    const words = all.slice(1);
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [words[i], words[j]] = [words[j], words[i]];
    }
    const deferred = idx < numDeferred;
    const queue = deferred ? words.slice() : [head, ...words];
    return { id, head, words, deferred, queue };
  });

  const numCats = cats.length;
  const totalPairs = cats.reduce((n, c) => n + c.queue.length, 0);
  if (!Number.isFinite(boardCapacity) || boardCapacity <= 0 || boardCapacity >= totalPairs) {
    for (const cat of cats) cat.boardN = cat.queue.length;
  } else {
    const cap = (cat) => Math.max(0, cat.queue.length - 1);
    const base = Math.floor(boardCapacity / numCats);
    let allocated = 0;
    for (const cat of cats) {
      cat.boardN = Math.min(base, cap(cat));
      allocated += cat.boardN;
    }
    let i = 0;
    const maxIter = numCats * 100;
    while (allocated < boardCapacity && i < maxIter) {
      const cat = cats[i % numCats];
      if (cat.boardN < cap(cat)) { cat.boardN++; allocated++; }
      i++;
    }
  }
  for (const cat of cats) {
    cat.boardQ = cat.queue.slice(0, cat.boardN);
    cat.stockQ = cat.queue.slice(cat.boardN);
    if (cat.deferred) cat.stockQ.unshift(cat.head);
  }

  const boardSeq = [];
  const active = [];
  let nextCatIdx = 0;
  const refill = () => {
    while (active.length < p.maxOpen && nextCatIdx < cats.length) {
      const c = cats[nextCatIdx++];
      if (c.boardQ.length > 0) active.push({ id: c.id, queue: c.boardQ.slice() });
    }
  };
  refill();
  let activeIdx = 0;
  let chunkLeft = p.chunkSize;
  while (active.length > 0) {
    const cat = active[activeIdx];
    boardSeq.push(cat.queue.shift());
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

  const stockSeq = [];
  for (const cat of cats) for (const pair of cat.stockQ) stockSeq.push(pair);
  for (let i = stockSeq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [stockSeq[i], stockSeq[j]] = [stockSeq[j], stockSeq[i]];
  }

  return boardSeq.concat(stockSeq);
}

function getBoardCapacity(level) {
  let n = 0;
  for (const s of level.stages) n += s.tiles.length;
  return n;
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
  const boardCapacity = getBoardCapacity(level);
  const sequence = buildSequenceByDifficulty(
    pairsByCat, level.difficulty, level.slotsAmount, boardCapacity
  );
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

  const boardCounts = new Map();
  for (const s of level.stages) for (const t of s.tiles) {
    boardCounts.set(t.categoryId, (boardCounts.get(t.categoryId) || 0) + 1);
  }
  const stockCounts = new Map();
  for (const w of level.stock) {
    let catId = null;
    for (const c of level.categories) {
      if (c.categoryId === w || (c.wordsIds || []).includes(w)) { catId = c.categoryId; break; }
    }
    if (catId) stockCounts.set(catId, (stockCounts.get(catId) || 0) + 1);
  }
  const dist = [...pairsByCat.keys()].map(c =>
    `${c}=${boardCounts.get(c) || 0}/${stockCounts.get(c) || 0}`
  ).join(' ');
  console.log(
    `${key}: ${level.difficulty}, slots=${level.slotsAmount}, ` +
    `board=${boardCapacity}, stock=${level.stock.length}\n  ${dist}`
  );
}

for (const key of LEVEL_KEYS) regenerateLevel(key);
buildBundle();
