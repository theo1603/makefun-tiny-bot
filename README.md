# makefun-tiny-bot

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/theo1603/makefun-tiny-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/theo1603/makefun-tiny-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Slow-trend momentum bot for hourly Solana bars: holds the strongest uptrending assets, sits in cash in a downtrend.

It reads each hourly bar, tracks a slow EMA(8)/EMA(24) trend filter per
symbol plus a SOL regime gate, and rebalances every 12 bars: risk-on it holds
the top 4 symbols by trailing 12-bar return at 25% each; risk-off it keeps
only tiny 2% probes in the best names (and a 5% probe when nothing is
positive), so it stays trading while barely losing in a grind down. Exits run
every bar: a 3% trailing stop below the peak since entry, or the fast EMA
falling 0.2% under the slow EMA, with a 6-bar cooldown before re-entry.
Sells settle one bar before the buys that replace them. All arithmetic is
integer fixed-point, so two runs agree exactly. No network, no randomness.

## Run it

```sh
node main.ts
```

`main.ts` speaks the `agent-fun/bars-replay/v1` line protocol on stdin/stdout
(one JSON reply per batch, echoing its `seq`); `vendor/makefun-bars.ts` is the
kit's protocol shim.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
