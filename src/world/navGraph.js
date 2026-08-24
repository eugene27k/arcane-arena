import * as THREE from 'three';

// Waypoint graph + A* for ground enemy navigation (PRD §20: grunts climb
// stairs/ramps; drop edges let them leap down ledges while pursuing).
export class NavGraph {
  constructor(nodeDefs, edgeDefs) {
    this.nodes = new Map();
    for (const n of nodeDefs) {
      this.nodes.set(n.id, {
        id: n.id,
        pos: new THREE.Vector3(n.pos[0], n.pos[1], n.pos[2]),
        edges: [],
      });
    }
    for (const e of edgeDefs) {
      if (Array.isArray(e)) {
        this._link(e[0], e[1]);
        this._link(e[1], e[0]);
      } else {
        this._link(e.a, e.b, true);
      }
    }
  }

  _link(a, b, drop = false) {
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) { console.warn(`NavGraph: bad edge ${a}->${b}`); return; }
    const cost = na.pos.distanceTo(nb.pos) * (drop ? 0.8 : 1);
    na.edges.push({ to: b, cost, drop });
  }

  // Nearest node, weighting vertical distance heavily so entities pick nodes
  // on their own floor.
  nearest(pos) {
    let best = null, bestD = Infinity;
    for (const n of this.nodes.values()) {
      const dx = n.pos.x - pos.x, dz = n.pos.z - pos.z;
      const dy = (n.pos.y - pos.y) * 3;
      const d = dx * dx + dz * dz + dy * dy;
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  // A* shortest path; returns array of Vector3 waypoints (excluding start node
  // if it's essentially the current position), or null.
  findPath(fromId, toId) {
    if (fromId === toId) return [this.nodes.get(toId).pos];
    const open = new Map([[fromId, 0]]);
    const g = new Map([[fromId, 0]]);
    const came = new Map();
    const target = this.nodes.get(toId).pos;

    while (open.size > 0) {
      let curId = null, curF = Infinity;
      for (const [id, f] of open) if (f < curF) { curF = f; curId = id; }
      if (curId === toId) {
        const path = [];
        let id = toId;
        while (id !== undefined) {
          path.unshift(this.nodes.get(id));
          id = came.get(id);
        }
        return path.map((n) => n.pos);
      }
      open.delete(curId);
      const cur = this.nodes.get(curId);
      for (const e of cur.edges) {
        const tentative = g.get(curId) + e.cost;
        if (tentative < (g.get(e.to) ?? Infinity)) {
          g.set(e.to, tentative);
          came.set(e.to, curId);
          open.set(e.to, tentative + this.nodes.get(e.to).pos.distanceTo(target));
        }
      }
    }
    return null;
  }
}
