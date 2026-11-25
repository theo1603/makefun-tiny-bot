// Tiny Bot — slow-trend cross-sectional momentum on hourly Solana bars.
//
// The final window is only 3 days and its regime is unknown, so the bot is
// built to lose almost nothing in a downtrend and to capture a rally when one
// shows up:
//  - a slow EMA(8)/EMA(24) trend filter per symbol, plus a SOL regime gate
//    (risk-on only while SOL's fast EMA sits above its slow EMA);
//  - risk-on: hold the top 4 symbols by trailing 12-bar return at 25% each,
//    so a broad rally deploys the cash a top-3 rule would leave idle;
//  - risk-off: tiny 2% probes in the top 2 names with a positive 12-bar
//    return (keeps the bot trading while capping the damage), and a 5%
//    probe in the least-bad name when nothing is positive at all;
//  - per-bar exits: a 3% trailing stop below the peak since entry, and an
//    exit when the fast EMA falls 0.2% below the slow EMA; a 6-bar cooldown
//    before a symbol can be re-entered;
//  - rebalances every 12 bars; sells settle one bar before the buys that
//    replace them, because a sell's proceeds never fund a buy of the same
//    reply; a 4% weight band suppresses churn on positions already held.
// All arithmetic is integer (BigInt) fixed-point, so two runs agree exactly:
// no clock, no environment, no randomness. Every batch is answered with one
// reply echoing its seq; the hello message and every batch of bars feed the
// history the signals read.

import { BPS, runBars, type BarsState, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const EMA_FAST_SPAN = 8;
const EMA_SLOW_SPAN = 24;
const LOOKBACK_BARS = 12;
const MIN_HISTORY_BARS = EMA_SLOW_SPAN + 2; // 26 closes before the first rebalance
const REBALANCE_EVERY = 12;
const TOP_ON = 4;
const WEIGHT_ON_BPS = 2500; // 25% of equity per name: the cap in hello
const TOP_OFF = 2;
const WEIGHT_OFF_BPS = 200; // 2% probes while risk-off
const PROBE_BPS = 500; // 5% probe when no name has a positive trailing return
const TRAIL_BPS = 300; // 3% trailing stop below the peak since entry
const EXIT_MARGIN_BPS = 20; // exit when fast EMA is 0.2% under slow EMA
const COOLDOWN_BARS = 6;
const BAND_BPS = 400; // ignore weight drift inside a 4% band
const MAX_SLIPPAGE_BPS = 10_000;
const SCALE = 1_000_000n; // fixed-point scale for the EMAs

/** Close history per symbol (null where a bar is missing). */
const closes = new Map<string, (bigint | null)[]>();
/** Fixed-point EMAs (price * SCALE) per symbol. */
const emaFast = new Map<string, bigint>();
const emaSlow = new Map<string, bigint>();
/** Highest close since the current position opened, per held symbol. */
const peak = new Map<string, bigint>();
/** First seq at which a symbol may be (re-)entered after an exit. */
const coolUntil = new Map<string, number>();
/** Target weight in bps per symbol, as last acted on. */
let targets = new Map<string, number>();
/** Targets whose buys are deferred one bar behind their sells. */
let pending: Map<string, number> | null = null;
let nextRebalance = 0;

function emaUpdate(prev: bigint | null, price: bigint, span: number): bigint {
  const scaled = price * SCALE;
  if (prev === null) return scaled;
  return prev + ((scaled - prev) * 2n) / BigInt(span + 1);
}

/** Current weight of a held symbol in bps of equity (0 when not held). */
function weightBps(state: BarsState, symbol: string): number {
  const pos = state.positions.get(symbol);
  if (pos === undefined || state.equity === 0n) return 0;
  return Number((state.value(symbol, pos.qty) * BPS) / state.equity);
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Orders that move current holdings to the target weights. A target of 0
 * always sells the whole position; a new name always buys its full target;
 * a held name is only adjusted when its weight is more than BAND_BPS away
 * from target. Buys are capped by the running cash budget and the weight
 * room, and skipped below the minimum notional.
 */
function ordersFor(state: BarsState, map: Map<string, number>): { sells: OrderInput[]; buys: OrderInput[] } {
  const sells: OrderInput[] = [];
  const buys: OrderInput[] = [];
  const { fees } = state.hello;
  let cash = state.cash;
  const symbols = new Set([...map.keys(), ...state.positions.keys()]);
  for (const symbol of symbols) {
    const targetBps = map.get(symbol) ?? 0;
    const pos = state.positions.get(symbol);
    const price = state.close(symbol);
    if (targetBps === 0) {
      if (pos !== undefined && price !== null) {
        sells.push({ side: 'sell', symbol, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      continue;
    }
    if (pos === undefined || price === null) {
      if (price === null) continue;
      // New entry: the full target weight, capped by cash and weight room.
      let notional = (BigInt(targetBps) * state.equity) / BPS;
      const room = state.weightRoom(symbol);
      if (notional > room) notional = room;
      if (notional > cash) notional = cash;
      if (notional < BigInt(fees.min_notional_quote_units)) continue;
      buys.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= notional;
      continue;
    }
    const currentBps = weightBps(state, symbol);
    const delta = targetBps - currentBps;
    if (delta <= -BAND_BPS) {
      // Sell the excess weight, proportionally.
      const currentValue = state.value(symbol, pos.qty);
      const excessValue = ((BigInt(-delta) * state.equity) / BPS);
      const sellQty = (pos.qty * excessValue) / currentValue;
      if (sellQty > 0n) sells.push({ side: 'sell', symbol, qty: sellQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    } else if (delta >= BAND_BPS) {
      let notional = (BigInt(delta) * state.equity) / BPS;
      const room = state.weightRoom(symbol);
      if (notional > room) notional = room;
      if (notional > cash) notional = cash;
      if (notional < BigInt(fees.min_notional_quote_units)) continue;
      buys.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= notional;
    }
  }
  return { sells, buys };
}

/** The fresh target map for a rebalance bar, from the ranking and regime. */
function pickTargets(state: BarsState, seq: number): Map<string, number> {
  const out = new Map<string, number>();
  const symbols = state.hello.symbols.map((s) => s.symbol);
  const solF = emaFast.get('SOL');
  const solS = emaSlow.get('SOL');
  const riskOn = solF !== undefined && solS !== undefined && solF > solS;

  // Rank by trailing LOOKBACK_BARS return, exactly (cross-multiplied);
  // Array.prototype.sort is stable, so ties keep hello order.
  const ranked: { symbol: string; now: bigint; then: bigint; up: boolean }[] = [];
  for (const symbol of symbols) {
    const arr = closes.get(symbol) ?? [];
    const now = arr[arr.length - 1];
    const then = arr[arr.length - 1 - LOOKBACK_BARS];
    if (now === undefined || now === null || then === undefined || then === null) continue;
    const f = emaFast.get(symbol);
    const s = emaSlow.get(symbol);
    ranked.push({ symbol, now, then, up: f !== undefined && s !== undefined && f > s });
  }
  ranked.sort((a, b) => {
    const l = a.now * b.then;
    const r = b.now * a.then;
    return l > r ? -1 : l < r ? 1 : 0;
  });
  const cooled = (symbol: string): boolean =>
    coolUntil.has(symbol) && seq < (coolUntil.get(symbol) ?? 0) && !state.positions.has(symbol);

  if (riskOn) {
    const cands = ranked.filter((x) => x.up && x.now > x.then && !cooled(x.symbol));
    for (const x of cands.slice(0, TOP_ON)) out.set(x.symbol, WEIGHT_ON_BPS);
    return out;
  }
  const cands = ranked.filter((x) => x.now > x.then && !cooled(x.symbol));
  if (cands.length > 0) {
    for (const x of cands.slice(0, TOP_OFF)) out.set(x.symbol, WEIGHT_OFF_BPS);
    return out;
  }
  // Total grind-down: one small probe in the least-bad name, to keep trading.
  const first = ranked.find((x) => !cooled(x.symbol));
  if (first !== undefined) out.set(first.symbol, PROBE_BPS);
  return out;
}

await runBars({
  onHello(state) {
    for (const { symbol } of state.hello.symbols) closes.set(symbol, []);
  },
  onBatch(state, batch) {
    // 1. Record this batch of bars: closes and EMAs, peaks while held.
    for (const { symbol } of state.hello.symbols) {
      const c = state.close(symbol);
      closes.get(symbol)?.push(c);
      if (c === null) continue;
      emaFast.set(symbol, emaUpdate(emaFast.get(symbol) ?? null, c, EMA_FAST_SPAN));
      emaSlow.set(symbol, emaUpdate(emaSlow.get(symbol) ?? null, c, EMA_SLOW_SPAN));
      if (state.positions.has(symbol)) {
        const p = peak.get(symbol);
        if (p === undefined || c > p) peak.set(symbol, c);
      }
    }
    // While warming up every order would be rejected: build history only.
    if (state.warmingUp) return [];

    // 2. Per-bar exits: trailing stop, or fast EMA under slow EMA.
    const working = new Map(targets);
    const exited: string[] = [];
    for (const [symbol] of state.positions) {
      const c = state.close(symbol);
      if (c === null) continue;
      const f = emaFast.get(symbol);
      const s = emaSlow.get(symbol);
      const pk = peak.get(symbol);
      let out = false;
      if (pk !== undefined && c * 10_000n < pk * (10_000n - BigInt(TRAIL_BPS))) out = true;
      if (f !== undefined && s !== undefined && f * 1000n < s * (1000n - BigInt(EXIT_MARGIN_BPS))) out = true;
      if (out) {
        working.set(symbol, 0);
        exited.push(symbol);
        coolUntil.set(symbol, batch.seq + COOLDOWN_BARS);
        peak.delete(symbol);
      }
    }

    // 3. Buys deferred behind last bar's sells: the sells have now filled,
    // so the cash is there. An exit that fired this bar removes its name.
    if (pending !== null) {
      const eff = new Map(pending);
      for (const s of exited) eff.set(s, 0);
      pending = null;
      const { sells, buys } = ordersFor(state, eff);
      targets = eff;
      return [...sells, ...buys];
    }

    // 4. Rebalance on schedule, once enough history exists.
    const seen = closes.get(state.hello.symbols[0]?.symbol ?? '')?.length ?? 0;
    if (seen >= MIN_HISTORY_BARS && batch.seq >= nextRebalance) {
      nextRebalance = batch.seq + REBALANCE_EVERY;
      const fresh = pickTargets(state, batch.seq);
      for (const s of exited) fresh.set(s, 0);
      if (mapsEqual(fresh, targets) && exited.length === 0) return [];
      const { sells, buys } = ordersFor(state, fresh);
      if (sells.length > 0 && buys.length > 0) {
        // A sell's proceeds never fund a buy of the same reply: send the
        // sells now, the buys on the next batch.
        pending = fresh;
        targets = fresh;
        return sells;
      }
      targets = fresh;
      return [...sells, ...buys];
    }

    // 5. Exits only, between rebalances.
    if (exited.length > 0) {
      targets = working;
      return ordersFor(state, working).sells;
    }
    return [];
  },
});
