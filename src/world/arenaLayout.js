// The arena: "Abandoned Demonic Cathedral" (PRD §25-§28).
// Single source of truth for geometry, nav graph and spawn points, authored
// together so grunt navigation always matches the architecture.
//
// Coordinates: x east, z south, y up. Playfield inner bounds |x|,|z| <= 27.
// Elevations: pit -3, main 0, platforms 3.5, balconies 7, bridge 11, stones ~13.4.

const STEP_H = 0.36; // max authored step rise (player/grunt stepHeight ~0.5)

// ---------- small helpers ----------
function box(minX, minY, minZ, maxX, maxY, maxZ, tint, opts = {}) {
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], tint, ...opts };
}

// Subtract hole rects from a base rect (XZ plane) -> list of cover rects.
function rectSubtract(base, holes) {
  let pieces = [base];
  for (const h of holes) {
    const next = [];
    for (const r of pieces) {
      const ix0 = Math.max(r.x0, h.x0), ix1 = Math.min(r.x1, h.x1);
      const iz0 = Math.max(r.z0, h.z0), iz1 = Math.min(r.z1, h.z1);
      if (ix0 >= ix1 || iz0 >= iz1) { next.push(r); continue; }
      if (r.z0 < iz0) next.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: iz0 });
      if (iz1 < r.z1) next.push({ x0: r.x0, x1: r.x1, z0: iz1, z1: r.z1 });
      if (r.x0 < ix0) next.push({ x0: r.x0, x1: ix0, z0: iz0, z1: iz1 });
      if (ix1 < r.x1) next.push({ x0: ix1, x1: r.x1, z0: iz0, z1: iz1 });
    }
    pieces = next;
  }
  return pieces;
}

// Staircase of solid steps. axis: 'x'|'z' (direction of travel).
// topEdge: coordinate (on axis) of the top landing edge; bottomEdge: far end at yBottom.
function stairsRun(out, axis, cross0, cross1, topEdge, bottomEdge, yTop, yBottom, tint) {
  const rise = yTop - yBottom;
  const n = Math.max(2, Math.ceil(rise / STEP_H));
  const stepH = rise / n;
  const dir = Math.sign(bottomEdge - topEdge);
  const depth = Math.abs(bottomEdge - topEdge) / n;
  const embed = yBottom - 1;
  for (let k = 0; k < n; k++) {
    const a0 = topEdge + dir * k * depth;
    const a1 = topEdge + dir * (k + 1) * depth;
    const top = yTop - (k + 1) * stepH;
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    if (axis === 'z') out.push(box(cross0, embed, lo, cross1, top, hi, tint));
    else out.push(box(lo, embed, cross0, hi, top, cross1, tint));
  }
}

// ---------- palette tints (vertex-colored stone) ----------
const T = {
  floor: 0x5d5866,
  floorDark: 0x4a4454,
  pit: 0x453e50,
  dais: 0x6d6472,
  platform: 0x605a6a,
  balcony: 0x585264,
  stairs: 0x6a6274,
  wall: 0x4e4858,
  column: 0x565064,
  bridge: 0x525060,
  stone: 0x5e6258,
  rubble: 0x504a5a,
};

export function buildLayout() {
  const colliders = [];   // boxes that block movement (also rendered)
  const visuals = [];     // rendered only (no collision)
  const rimStrips = [];   // emissive abyss warnings
  const windows = [];     // emissive gothic windows
  const torches = [];     // { pos:[x,y,z] }
  const abyssRects = [];  // { x0,z0,x1,z1 } for glow planes / embers

  // ================= FLOORS =================
  const PIT = { x0: -27, x1: -6, z0: 6, z1: 27 };
  const ABYSS_A = { x0: -24, x1: -12, z0: -24, z1: -14 }; // NW hole
  const ABYSS_B = { x0: 16, x1: 27, z0: -8, z1: 4 };      // E hole (to the wall)
  abyssRects.push(ABYSS_A, ABYSS_B);

  for (const r of rectSubtract({ x0: -27, x1: 27, z0: -27, z1: 27 }, [PIT, ABYSS_A, ABYSS_B])) {
    colliders.push(box(r.x0, -4, r.z0, r.x1, 0, r.z1, T.floor));
  }
  // Pit (lower combat floor)
  colliders.push(box(PIT.x0, -4, PIT.z0, PIT.x1, -3, PIT.z1, T.pit));
  // Pit stairs
  stairsRun(colliders, 'z', -16, -12, 6, 12, 0, -3, T.stairs);   // P1: main -> pit (south)
  stairsRun(colliders, 'x', 16, 20, -6, -12, 0, -3, T.stairs);   // P2: main -> pit (west)

  // ================= CENTRAL DAIS =================
  colliders.push(box(-5, 0, -5, 5, 0.35, 5, T.dais));
  colliders.push(box(-4, 0, -4, 4, 0.7, 4, T.dais));

  // ================= MID PLATFORMS (3.5) =================
  colliders.push(box(-27, 2.9, -10, -16, 3.5, 2, T.platform));       // west platform
  stairsRun(colliders, 'x', -6, -2, -16, -9.5, 3.5, 0, T.stairs);    // W1
  colliders.push(box(16, 2.9, 8, 27, 3.5, 20, T.platform));          // east platform
  stairsRun(colliders, 'x', 10, 14, 16, 9.5, 3.5, 0, T.stairs);      // E1

  // ================= BALCONIES (7) =================
  colliders.push(box(-27, 6.4, -27, 14, 7, -20, T.balcony));         // north balcony
  stairsRun(colliders, 'z', -27, -23, -16.5, -10, 7, 3.5, T.stairs); // N1: west plat -> balcony
  colliders.push(box(-27, 6.4, -20, -23, 7, -16.5, T.balcony));      // N1 landing
  stairsRun(colliders, 'x', -27, -23, 14, 26, 7, 0, T.stairs);       // N2: main NE -> balcony
  colliders.push(box(6, 6.4, 20, 27, 7, 27, T.balcony));             // south balcony
  stairsRun(colliders, 'z', 17, 21, 20, 14, 7, 3.5, T.stairs);       // S1: east plat -> balcony

  // ================= BRIDGE (11) + stones =================
  colliders.push(box(-1.5, 10.5, -24.5, 1.5, 11, 12, T.bridge));     // high bridge
  stairsRun(colliders, 'x', -24.5, -20.5, -1.5, -8.1, 11, 7, T.stairs); // balcony -> bridge
  colliders.push(box(3, 11, 12.5, 6.5, 12.2, 16, T.stone));          // floating stone A
  colliders.push(box(7.5, 12.2, 16.5, 11, 13.4, 20, T.stone));       // floating stone B
  colliders.push(box(12.5, 12.2, 20.5, 16, 13.4, 24, T.stone));      // floating stone C

  // ================= COLUMNS =================
  for (const [cx, cz] of [[10, -10], [-10, -10], [10, 10], [-10, 10]]) {
    const base = (cx === -10 && cz === 10) ? -4 : -1; // SW column stands in the pit
    colliders.push(box(cx - 1.2, base, cz - 1.2, cx + 1.2, 24, cz + 1.2, T.column));
    // capital / base trim (visual)
    visuals.push(box(cx - 1.5, 0, cz - 1.5, cx + 1.5, 0.5, cz + 1.5, T.column));
    visuals.push(box(cx - 1.5, 23.2, cz - 1.5, cx + 1.5, 24, cz + 1.5, T.column));
  }
  // Broken column stubs (jumpable cover)
  colliders.push(box(5.1, -1, -14.9, 6.9, 1.3, -13.1, T.rubble));
  colliders.push(box(-2.9, -1, 15.1, -1.1, 1.3, 16.9, T.rubble));
  colliders.push(box(13.1, -1, 6.1, 14.9, 1.3, 7.9, T.rubble));
  colliders.push(box(-20.9, -4, 19.1, -19.1, -1.7, 20.9, T.rubble)); // in the pit

  // ================= WALLS & CEILING =================
  colliders.push(box(-28.5, -6, -28.5, -27, 26, 28.5, T.wall)); // west
  colliders.push(box(27, -6, -28.5, 28.5, 26, 28.5, T.wall));   // east
  colliders.push(box(-27, -6, -28.5, 27, 26, -27, T.wall));     // north
  colliders.push(box(-27, -6, 27, 27, 26, 28.5, T.wall));       // south
  for (const r of rectSubtract({ x0: -28.5, x1: 28.5, z0: -28.5, z1: 28.5 }, [{ x0: -8, x1: 8, z0: -8, z1: 8 }])) {
    visuals.push(box(r.x0, 26, r.z0, r.x1, 27.5, r.z1, T.wall)); // ceiling with oculus
  }

  // Wall pilasters (visual depth)
  for (let i = -21; i <= 21; i += 10.5) {
    visuals.push(box(-27.4, -1, i - 0.7, -26.6, 22, i + 0.7, T.floorDark));
    visuals.push(box(26.6, -1, i - 0.7, 27.4, 22, i + 0.7, T.floorDark));
    visuals.push(box(i - 0.7, -1, -27.4, i + 0.7, 22, -26.6, T.floorDark));
    visuals.push(box(i - 0.7, -1, 26.6, i + 0.7, 22, 27.4, T.floorDark));
  }

  // Gothic windows (emissive, on the walls)
  for (const z of [-16, 0, 16]) {
    windows.push({ pos: [-26.9, 14, z], size: [0.25, 9, 2.2], axis: 'x' });
    windows.push({ pos: [26.9, 14, z], size: [0.25, 9, 2.2], axis: 'x' });
  }
  for (const x of [-16, 0, 16]) {
    windows.push({ pos: [x, 14, -26.9], size: [2.2, 9, 0.25], axis: 'z' });
    windows.push({ pos: [x, 14, 26.9], size: [2.2, 9, 0.25], axis: 'z' });
  }

  // ================= ABYSS DRESSING =================
  const strip = (x0, z0, x1, z1) => rimStrips.push(box(x0, 0.02, z0, x1, 0.2, z1, 0xff2a18));
  for (const A of abyssRects) {
    strip(A.x0 - 0.35, A.z0 - 0.35, A.x1 + 0.35, A.z0);       // north rim
    strip(A.x0 - 0.35, A.z1, A.x1 + 0.35, A.z1 + 0.35);       // south rim
    strip(A.x0 - 0.35, A.z0, A.x0, A.z1);                     // west rim
    if (A.x1 < 27) strip(A.x1, A.z0, A.x1 + 0.35, A.z1);      // east rim
    // warning posts at the corners — visible from any approach angle
    const posts = [[A.x0, A.z0], [A.x1, A.z0], [A.x0, A.z1], [A.x1, A.z1]];
    for (const [px, pz] of posts) {
      if (Math.abs(px) >= 27 || Math.abs(pz) >= 27) continue;
      rimStrips.push(box(px - 0.09, 0, pz - 0.09, px + 0.09, 1.45, pz + 0.09, 0xff2a18));
    }
  }
  // Jagged broken-edge rocks (visual only)
  const jag = (x, z, s, y = 0) => visuals.push(box(x - s, y - 0.5, z - s, x + s, y + 0.28, z + s, T.floorDark, { rot: Math.random() * 0.5, surf: 'rough' }));
  jag(-12.4, -14.4, 0.8); jag(-23.6, -14.3, 0.7); jag(-12.3, -23.5, 0.7); jag(-18, -13.8, 0.9);
  jag(16.3, 3.6, 0.8); jag(16.4, -7.5, 0.7); jag(20, 4.3, 0.9); jag(24, -7.8, 0.7);

  // ================= SUPPORTS (visual) =================
  const support = (x, z, y0, y1) => visuals.push(box(x - 0.45, y0, z - 0.45, x + 0.45, y1, z + 0.45, T.floorDark));
  support(-17, 0, 2.9, -8.5); support(-17, -1, 2.9, -8.5);
  support(17, 9, 0, 2.9); support(17, 19, 0, 2.9); support(26, 9, 0, 2.9);
  support(-25, -10.5, 0, 6.4); support(-25, -16.5, 0, 6.4); // N1 stair supports
  support(13, -21, 0, 6.4); support(-13, -21, 0, 6.4); support(0, -21, 0, 6.4);
  support(7, 21, 0, 6.4); support(20, 21, 0, 6.4);
  support(0, -14, 7, 10.5); support(0, -2, 0.7, 10.5); support(0, 9, 0, 10.5); // bridge piers

  // ================= TORCHES =================
  for (const [cx, cz] of [[10, -10], [-10, -10], [10, 10], [-10, 10]]) {
    const tx = cx - Math.sign(cx) * 1.45;
    const tz = cz - Math.sign(cz) * 1.45;
    torches.push({ pos: [tx, 3.2, tz] });
  }
  torches.push({ pos: [-26.4, 5.6, -4] });   // west platform wall
  torches.push({ pos: [26.4, 5.6, 14] });    // east platform wall
  torches.push({ pos: [0, 9.4, -26.4] });    // north balcony wall
  torches.push({ pos: [16, 9.4, 26.4] });    // south balcony wall

  // ================= SPAWN POINTS =================
  const spawnPoints = {
    ground: [
      { pos: [-20, 0, 4.5] },   // west main, before the platform
      { pos: [12, 0, 24] },     // under the south balcony
      { pos: [20, 0, -20] },    // NE main
      { pos: [-16, -3, 18] },   // pit
      { pos: [-22, 3.5, -4] },  // west platform
      { pos: [24, 3.5, 11] },   // east platform
      { pos: [0, 7, -24] },     // north balcony
      { pos: [16, 7, 23.5] },   // south balcony
    ],
    aerial: [
      { pos: [5, 11, -5] },
      { pos: [-14, 8, 12] },
      { pos: [18, 10, -14] },
      { pos: [-14, 11, -17] },
    ],
  };

  // ================= NAV GRAPH =================
  const N = (id, x, y, z) => ({ id, pos: [x, y, z] });
  const navNodes = [
    N('dais', 0, 0.7, 0),
    N('m_n', 0, 0, -12), N('m_ne', 19, 0, -18), N('m_nw', -16, 0, -8),
    N('m_e', 10, 0, 6), N('m_se', 11, 0, 22), N('m_s', 0, 0, 15), N('m_w', -11, 0, 1),
    N('d_s', 2, 0, 18),
    N('p_c', -16, -3, 16), N('p1_bot', -14, -3, 13.2), N('p1_top', -14, 0, 4.8),
    N('p2_bot', -13.2, -3, 18), N('p2_top', -4.8, 0, 18),
    N('w_bot', -8.2, 0, -4), N('w_top', -17.2, 3.5, -4), N('w_c', -22, 3.5, -4),
    N('e_bot', 8.2, 0, 12), N('e_top', 17.2, 3.5, 12), N('e_c', 22, 3.5, 16),
    N('n1_bot', -25, 3.5, -8.8), N('n1_top', -25, 7, -17.5),
    N('n_w', -22, 7, -23.5), N('n_c', 0, 7, -23.5), N('n_e', 11, 7, -23.5),
    N('n2_top', 14.6, 7, -25), N('n2_bot', 25.7, 0.35, -25), N('n2_ent', 25.7, 0, -20),
    N('s1_bot', 19, 3.5, 13), N('s1_top', 19, 7, 20.8), N('s_c', 16, 7, 23.5), N('s_w', 8, 7, 23.5),
    N('bs_bot', -9, 7, -22.5), N('bs_top', -2.2, 11, -22.5), N('br_n', 0, 11, -16), N('br_s', 0, 11, 10.5),
  ];
  // [a, b] bidirectional walk; { a, b, drop:true } one-way a->b (walks off a ledge)
  const navEdges = [
    ['dais', 'm_n'], ['dais', 'm_e'], ['dais', 'm_s'], ['dais', 'm_w'],
    ['m_n', 'm_nw'], ['m_n', 'm_ne'], ['m_n', 'm_e'], ['m_e', 'm_se'], ['m_s', 'm_se'],
    ['m_s', 'd_s'], ['d_s', 'm_se'], ['m_s', 'p2_top'], ['m_w', 'm_nw'],
    ['m_w', 'w_bot'], ['m_nw', 'w_bot'], ['m_w', 'p1_top'], ['m_nw', 'p1_top'],
    ['p1_top', 'p1_bot'], ['p1_bot', 'p_c'], ['p2_top', 'p2_bot'], ['p2_bot', 'p_c'],
    ['w_bot', 'w_top'], ['w_top', 'w_c'], ['w_c', 'n1_bot'], ['n1_bot', 'n1_top'],
    ['n1_top', 'n_w'], ['n_w', 'n_c'], ['n_c', 'n_e'], ['n_e', 'n2_top'],
    ['n2_top', 'n2_bot'], ['n2_bot', 'n2_ent'], ['n2_ent', 'm_ne'],
    ['e_bot', 'e_top'], ['e_bot', 'm_e'], ['e_bot', 'm_se'], ['e_top', 'e_c'],
    ['e_c', 's1_bot'], ['s1_bot', 's1_top'], ['s1_top', 's_c'], ['s_c', 's_w'],
    ['n_c', 'bs_bot'], ['bs_bot', 'bs_top'], ['bs_top', 'br_n'], ['br_n', 'br_s'],
    // one-way ledge drops (demons leap down while pursuing)
    { a: 'w_c', b: 'm_w', drop: true },
    { a: 'e_c', b: 'm_se', drop: true },
    { a: 'n_c', b: 'm_n', drop: true },
    { a: 'n_e', b: 'm_ne', drop: true },
    { a: 's_w', b: 'd_s', drop: true },
    { a: 'br_s', b: 'm_e', drop: true },
    { a: 'm_w', b: 'p_c', drop: true },
    { a: 'p2_top', b: 'p2_bot', drop: true },
  ];

  return {
    colliders, visuals, rimStrips, windows, torches, abyssRects, spawnPoints,
    navNodes, navEdges,
    bounds: { min: [-27, -6, -27], max: [27, 26, 27] },
    oculus: { x0: -8, x1: 8, z0: -8, z1: 8 },
    magicCircle: { pos: [0, 0.72, 0], radius: 3.6 },
  };
}
