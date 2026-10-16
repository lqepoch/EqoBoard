// Decides which trades may move the price. Only continuous automatch prints are candidates, and a
// candidate that jumps more than MAX_JUMP away from the last accepted price is held back. It counts
// as a real move only after CONFIRM consecutive prints agree within CLUSTER of each other. A single
// bad print (for example one far off-market print) therefore never moves the chart, while a real
// fast move is accepted after a few prints. Held-back trades still count toward volume.
const MAX_JUMP = 0.005;
const CLUSTER = 0.002;
const CONFIRM = 5;

export class PriceFilter {
  #state = new Map();

  /** True when this trade may move the price of its symbol. Must be called in trade order. */
  judge(symbol, trade) {
    if (trade.tickType !== 'Automatch') return false;
    let s = this.#state.get(symbol);
    if (!s) {
      s = { ref: null, pending: [] };
      this.#state.set(symbol, s);
    }
    const p = trade.price;
    if (s.ref === null || Math.abs(p - s.ref) <= s.ref * MAX_JUMP) {
      s.ref = p;
      s.pending = [];
      return true;
    }
    const head = s.pending[0];
    if (head !== undefined && Math.abs(p - head) > head * CLUSTER) s.pending = [];
    s.pending.push(p);
    if (s.pending.length >= CONFIRM) {
      s.ref = p;
      s.pending = [];
      return true;
    }
    return false;
  }
}
