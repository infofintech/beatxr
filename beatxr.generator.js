// Turns an onset list into a playable chart: 4 lanes x 3 layers, two hands,
// eight cut directions. The goal is "flow" - consecutive same-hand notes should
// alternate swing direction so the saber never has to teleport.

export const DIR = {
  UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3,
  UP_LEFT: 4, UP_RIGHT: 5, DOWN_LEFT: 6, DOWN_RIGHT: 7,
  ANY: 8,
};

// Swing vector for each direction (x right, y up). ANY has no constraint.
export const DIR_VECTORS = [
  [0, 1], [0, -1], [-1, 0], [1, 0],
  [-0.707, 0.707], [0.707, 0.707], [-0.707, -0.707], [0.707, -0.707],
  [0, 0],
];

export const DIFFICULTIES = {
  chill:  { label: 'Chill',  minGap: 0.42, maxNps: 2.2, strength: 0.34, doubles: false, njs: 9,  reaction: 1.65 },
  easy:   { label: 'Easy',   minGap: 0.30, maxNps: 3.4, strength: 0.26, doubles: true,  njs: 11, reaction: 1.55 },
  normal: { label: 'Normal', minGap: 0.21, maxNps: 4.8, strength: 0.20, doubles: true,  njs: 13, reaction: 1.45 },
  hard:   { label: 'Hard',   minGap: 0.155, maxNps: 6.5, strength: 0.15, doubles: true, njs: 15, reaction: 1.35 },
  expert: { label: 'Expert', minGap: 0.115, maxNps: 8.5, strength: 0.10, doubles: true, njs: 17, reaction: 1.25 },
};

function mulberry32(seed) {
  return function rng() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Snap onsets onto the nearest 1/4 beat when they're already close to it. */
function quantize(onsets, bpm, beatOffset) {
  const beat = 60 / bpm;
  const step = beat / 4;
  const tolerance = step * 0.4;
  return onsets.map((o) => {
    const rel = o.time - beatOffset;
    const snapped = Math.round(rel / step) * step + beatOffset;
    const t = Math.abs(snapped - o.time) <= tolerance ? snapped : o.time;
    return { ...o, time: Math.max(0, t), beat: (t - beatOffset) / beat };
  });
}

/** Drop onsets that are too weak, too close together, or push local density too high. */
function thin(onsets, cfg) {
  const strong = onsets.filter((o) => o.strength >= cfg.strength);

  const kept = [];
  for (const o of strong) {
    const last = kept[kept.length - 1];
    if (last && o.time - last.time < cfg.minGap) {
      // Two onsets fighting for the same slot: keep the more prominent one.
      if (o.strength > last.strength * 1.15) kept[kept.length - 1] = o;
      continue;
    }
    kept.push(o);
  }

  // Sliding 2-second window density cap.
  const window = 2.0;
  const maxInWindow = Math.round(cfg.maxNps * window);
  for (let i = 0; i < kept.length; i++) {
    let j = i;
    while (j < kept.length && kept[j].time - kept[i].time < window) j++;
    const count = j - i;
    if (count <= maxInWindow) continue;
    const slice = kept.slice(i, j).sort((a, b) => a.strength - b.strength);
    const drop = new Set(slice.slice(0, count - maxInWindow).map((o) => o.time));
    for (let k = j - 1; k >= i; k--) if (drop.has(kept[k].time)) kept.splice(k, 1);
  }

  return kept;
}

function layerForBand(band, strength) {
  // Low frequencies sit low, hats and cymbals sit high. Loud hits get pushed
  // toward the middle row where they're most comfortable to hit.
  if (band <= 1) return strength > 0.75 ? 1 : 0;
  if (band <= 4) return 1;
  return strength > 0.6 ? 2 : 1;
}

/** Vertical component of a direction: +1 up, -1 down, 0 horizontal. */
function verticalOf(dir) {
  return DIR_VECTORS[dir][1] > 0.3 ? 1 : DIR_VECTORS[dir][1] < -0.3 ? -1 : 0;
}

function pickDirection(layer, laneDelta, prevDir, restedLong, rng) {
  // After a rest, start with the natural swing for that height.
  if (restedLong || prevDir === null) {
    if (layer === 2) return rng() < 0.75 ? DIR.DOWN : DIR.DOWN_RIGHT;
    return rng() < 0.8 ? DIR.DOWN : DIR.UP;
  }

  const prevVertical = verticalOf(prevDir);
  const goUp = prevVertical <= 0; // alternate: a down-swing is followed by an up-swing

  // Big lane jumps read better as diagonals in the direction of travel.
  if (Math.abs(laneDelta) >= 2 && rng() < 0.7) {
    if (goUp) return laneDelta > 0 ? DIR.UP_RIGHT : DIR.UP_LEFT;
    return laneDelta > 0 ? DIR.DOWN_RIGHT : DIR.DOWN_LEFT;
  }

  if (rng() < 0.25) {
    // Occasional diagonal for variety, biased away from the previous lane.
    const right = laneDelta > 0 || (laneDelta === 0 && rng() < 0.5);
    if (goUp) return right ? DIR.UP_RIGHT : DIR.UP_LEFT;
    return right ? DIR.DOWN_RIGHT : DIR.DOWN_LEFT;
  }

  if (layer === 2 && !goUp && rng() < 0.5) return DIR.DOWN; // top row down-cuts feel good
  return goUp ? DIR.UP : DIR.DOWN;
}

function pickLane(hand, prevLane, rng) {
  // hand 0 = left/red owns the left half, hand 1 = right/blue the right half.
  const home = hand === 0 ? [0, 1] : [2, 3];
  const cross = hand === 0 ? 2 : 1;
  const r = rng();
  let lane;
  if (r < 0.12) lane = cross;              // occasional inner crossover
  else if (r < 0.56) lane = home[0];
  else lane = home[1];
  // Avoid repeating the exact same lane too often.
  if (lane === prevLane && rng() < 0.55) lane = home[lane === home[0] ? 1 : 0];
  return lane;
}

export function generateChart(analysis, difficultyKey = 'normal', options = {}) {
  const cfg = { ...DIFFICULTIES[difficultyKey] };
  if (options.densityScale) {
    cfg.minGap /= options.densityScale;
    cfg.maxNps *= options.densityScale;
  }

  const rng = mulberry32(Math.round(analysis.duration * 1000) ^ 0x5eed);
  const quantized = quantize(analysis.onsets, analysis.bpm, analysis.beatOffset);
  const picked = thin(quantized, cfg);

  const notes = [];
  const state = [
    { time: -99, dir: null, lane: 1, layer: 1 },
    { time: -99, dir: null, lane: 2, layer: 1 },
  ];
  let lastHand = 1;
  let lastTime = -99;
  const beat = 60 / analysis.bpm;

  for (let i = 0; i < picked.length; i++) {
    const o = picked[i];
    const gap = o.time - lastTime;
    const nextGap = i + 1 < picked.length ? picked[i + 1].time - o.time : 99;

    // A loud, isolated hit becomes a two-hand chord.
    const isDouble = cfg.doubles && o.strength > 0.82 && gap > 0.34 && nextGap > 0.34
      && o.time - Math.max(state[0].time, state[1].time) > 0.3 && rng() < 0.55;

    if (isDouble) {
      const layer = layerForBand(o.band, o.strength);
      for (const hand of [0, 1]) {
        const s = state[hand];
        const lane = hand === 0 ? (rng() < 0.6 ? 0 : 1) : (rng() < 0.6 ? 3 : 2);
        const restedLong = o.time - s.time > beat * 1.5;
        const dir = pickDirection(layer, lane - s.lane, s.dir, restedLong, rng);
        notes.push({ time: o.time, lane, layer, hand, dir, strength: o.strength });
        state[hand] = { time: o.time, dir, lane, layer };
      }
      lastTime = o.time;
      lastHand = 1;
      continue;
    }

    // Streams alternate hands; slower passages let one hand carry a phrase.
    let hand;
    if (gap < beat * 0.4) hand = 1 - lastHand;
    else if (gap > beat * 1.5) hand = o.band <= 2 ? (rng() < 0.5 ? 0 : 1) : 1 - lastHand;
    else hand = rng() < 0.78 ? 1 - lastHand : lastHand;

    const s = state[hand];
    const layer = layerForBand(o.band, o.strength);
    const lane = pickLane(hand, s.lane, rng);
    const restedLong = o.time - s.time > beat * 1.75;
    let dir = pickDirection(layer, lane - s.lane, s.dir, restedLong, rng);

    // A same-hand note arriving very fast after the previous one must be a clean
    // reversal, otherwise it's physically impossible to hit.
    if (o.time - s.time < 0.14 && s.dir !== null) {
      dir = verticalOf(s.dir) >= 0 ? DIR.DOWN : DIR.UP;
    }

    notes.push({ time: o.time, lane, layer, hand, dir, strength: o.strength });
    state[hand] = { time: o.time, dir, lane, layer };
    lastHand = hand;
    lastTime = o.time;
  }

  // Resolve simultaneous notes that would force the arms to cross.
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (Math.abs(a.time - b.time) > 0.02 || a.hand === b.hand) continue;
    const left = a.hand === 0 ? a : b;
    const right = a.hand === 0 ? b : a;
    if (left.lane >= right.lane) {
      left.lane = Math.min(left.lane, 1);
      right.lane = Math.max(right.lane, 2);
    }
    if (left.lane === right.lane && left.layer === right.layer) left.layer = (left.layer + 1) % 3;
  }

  notes.sort((a, b) => a.time - b.time);

  const duration = analysis.duration || (notes.length ? notes[notes.length - 1].time : 1);
  return {
    notes,
    bpm: analysis.bpm,
    duration,
    njs: cfg.njs,
    reaction: cfg.reaction,
    difficulty: difficultyKey,
    nps: notes.length / Math.max(1, duration),
  };
}
