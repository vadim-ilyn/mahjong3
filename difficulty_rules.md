# How difficulty is determined

Difficulty in this codebase isn't a single number — it's a tuple of knobs applied by `buildSequenceByDifficulty` in `editor.html` (mirrored in `scripts/regenerate-levels.js`). Three knobs vary by tier, two more vary per-level.

## The three algorithm knobs

| Tier | `maxOpen` | `chunkSize` | `jokerDeferRatio` |
|---|---:|---:|---:|
| easy | `min(2, slots)` | 1 | 0 |
| normal | `min(4, slots)` | 1 | 0.2 |
| hard | `min(6, slots)` | 1 | 0.45 |
| veryhard | `slots` (= 6) | 1 | 0.7 |

### 1. `maxOpen` — concurrent-category pressure on the board portion

Controls how many categories are "in flight" at once while the algorithm builds the **board portion** of the sequence. With `chunkSize: 1` (always), the algorithm round-robins through `maxOpen` active categories one tile at a time. When an active category's board quota empties, the next category joins the active pool.

- easy=2 → board tiles arrive in long waves of 2 categories alternating
- veryhard=6 → all 6 cats juggled tile-by-tile, then waves of newer cats

This shapes the *order* in which the player encounters tiles, not which tiles end up where.

### 2. `chunkSize` — same-category run length (currently disabled)

How many same-category tiles emit in a row before rotating. Currently locked at 1 across all tiers, so it doesn't differentiate anything right now. If you ever wanted a softer easy mode, bumping easy's chunkSize would make easy feel more grouped.

### 3. `jokerDeferRatio` — fraction of categories whose joker (category-head) is hidden in stock

The shuffled category list is split: the **first `floor(numCats × ratio)` cats** are "joker-deferred." Their category-head tile (the joker) is removed from the board pool and prepended into their stock pool instead. Word tiles still split between board and stock the same way.

For our 11-category levels this resolves to:

| Tier | Deferred cats | Jokers on board | Jokers in stock |
|---|---:|---:|---:|
| easy | 0 | 11 | 0 |
| normal | 2 | 9 | 2 |
| hard | 4 (`floor(11×0.45)`) | 7 | 4 |
| veryhard | 7 | **4** | **7** |

A deferred category's word tiles still land on the board, but **the player can't drop them into a slot** until they flip the joker out of stock — `canAcceptDrop` rejects word tiles when no slot of that category exists yet. This is the biggest difficulty lever.

## The per-category board/stock split (same for all tiers)

This happens after the deferral split but isn't graded by difficulty:

- **Even-allocation**: every category gets `floor(boardCapacity / numCats)` tiles on the board.
- **Stock-forcing cap**: each category's board allocation is capped at `queue.length − 1`, **guaranteeing at least one tile per category lands in stock**. The player can't complete any category from the board alone.
- **Remainder distribution**: leftover board slots are round-robin'd to categories with cap headroom (the bigger categories absorb the extras).

For all four shipped levels this means: 56 board / 24 stock, every category has 4–7 tiles on the board and 1–4 in stock (plus joker location moves to stock for deferred cats).

## The per-level knobs (do NOT vary by tier algorithm)

These are fixed per-level in the JSON, not derived from `difficulty`:

- **`slotsAmount`** (6 for all levels): how many parallel slots the player can hold. With 11 categories and 6 slots, the player must complete 5 cats before starting the last 5.
- **`movesCount`** (150 for all levels): move budget. `movesCount` is intentionally not used as a difficulty lever; all levels use 150.

## What the algorithm does NOT do

- It doesn't change `slotsAmount` or `movesCount` per tier.
- It doesn't change which board *positions* exist (`stages` layout is fixed per level).
- It doesn't change `chunkSize` (locked at 1).
- It doesn't pick *which* cats get deferred — they're just the first N after a single shuffle of the category list.

## In one sentence

**Difficulty grade ≈ how many categories you have to wait for from stock (`jokerDeferRatio`) plus how many categories arrive jumbled together on the board (`maxOpen`).**
