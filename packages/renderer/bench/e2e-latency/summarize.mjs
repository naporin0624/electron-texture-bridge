// Turns the JSONL written by run-matrix.mjs into markdown tables.
//
//   node packages/renderer/bench/e2e-latency/summarize.mjs <results.jsonl> [more.jsonl ...]
//   node packages/renderer/bench/e2e-latency/summarize.mjs --fanout <fanout.jsonl>
//
// Cells are "mean / p95 / p99" in ms unless noted. When a config was run more than once the
// last record wins (default mode). `--fanout` prints B-vs-F tables for MATRIX=fanout output:
// repeated configs are reduced to the median across repeats, and every repeat of the 4K N=16
// configs is also listed individually.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const FANOUT = args.includes("--fanout");
const files = args.filter((a) => a !== "--fanout");
const records = new Map();
const key = (c) => `${c.PIPE}/${c.DRAW}/${c.W}x${c.H}/N=${c.N}${c.WINDOWS ? "/win" : ""}`;
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    records.set(key(r.config), r);
  }
}
const rows = [...records.values()];
const f1 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x.toFixed(1));
const f2 = (x) => (x === undefined || x === null || Number.isNaN(x) ? "–" : x.toFixed(2));
const cell = (s) => (s && s.n ? `${f2(s.mean)} / ${f2(s.p95)} / ${f2(s.p99)}` : "–");
const table = (title, head, body) => {
  console.log(`\n### ${title}\n`);
  console.log(`| ${head.join(" | ")} |`);
  console.log(`| ${head.map(() => "---").join(" | ")} |`);
  for (const b of body) console.log(`| ${b.join(" | ")} |`);
};

// ---------------------------------------------------------------- --fanout (B vs F)
const printFanout = (all) => {
  const median = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (v.length === 0) return NaN;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const cfgKey = (c) => `${c.DRAW}/${c.W === 3840 ? "4K" : "1080p"}/N=${c.N}`;
  const okRuns = all.filter((r) => !r.error);
  const groups = new Map();
  for (const r of okRuns) {
    const k = cfgKey(r.config);
    if (!groups.has(k)) groups.set(k, { B: [], F: [] });
    groups.get(k)[r.config.PIPE]?.push(r);
  }
  const metric = {
    pubImp: (r) => r.imports?.pub_import?.mean,
    pubImpP95: (r) => r.imports?.pub_import?.p95,
    impPerFrame: (r) => r.imports?.perPublishedFrame,
    rx: (r) => r.stages.totalLatestPub_pub_rx.mean,
    rxP95: (r) => r.stages.totalLatestPub_pub_rx.p95,
    draw: (r) => r.stages.totalLatestPub_pub_draw.mean,
    drawP95: (r) => r.stages.totalLatestPub_pub_draw.p95,
    gpu: (r) => r.stages.totalLatestPub_pub_gpu.mean,
    gpuP95: (r) => r.stages.totalLatestPub_pub_gpu.p95,
    pubFps: (r) => r.publishedFps,
    dlv: (r) => r.deliveredFps.mean,
    dlvMin: (r) => r.deliveredFps.min,
    drawn: (r) => r.drawnFps.mean,
    drops: (r) => r.dropsPerReceiver.publishedMinusDelivered,
    superseded: (r) => r.rendererSuperseded,
    eldP99: (r) => r.eventLoopDelayMs.p99,
    eldMax: (r) => r.eventLoopDelayMs.max,
    rafMean: (r) => r.rafIntervalMs.mean,
    rafMax: (r) => r.rafIntervalMs.max,
    depth: (r) => r.rendererInWindow.maxDepth,
    upP99: (r) => r.producerUploadMs.p99,
  };
  const med = (runs, m) => median(runs.map(metric[m]));
  const pair = (g, m, fmt) => `${fmt(med(g.B, m))} / ${fmt(med(g.F, m))}`;
  const keys = [...groups.keys()];
  const reps = (g) => `${g.B.length}/${g.F.length}`;
  table(
    "Latency, B / F (median over repeats of each run's mean; p95 likewise) ms",
    [
      "config",
      "runs B/F",
      "imports per published frame",
      "pub→import (≈pub→cb) mean",
      "pub→import p95",
      "pub→T_rx mean",
      "pub→T_rx p95",
      "pub→T_draw mean (2d)",
      "pub→GPU done mean (webgpu)",
      "pub→GPU done p95 (webgpu)",
    ],
    keys.map((k) => {
      const g = groups.get(k);
      const d = k.startsWith("2d/");
      const w = k.startsWith("webgpu/");
      return [
        k,
        reps(g),
        pair(g, "impPerFrame", f2),
        pair(g, "pubImp", f2),
        pair(g, "pubImpP95", f2),
        pair(g, "rx", f2),
        pair(g, "rxP95", f2),
        d ? pair(g, "draw", f2) : "–",
        w ? pair(g, "gpu", f1) : "–",
        w ? pair(g, "gpuP95", f1) : "–",
      ];
    }),
  );
  table(
    "Throughput and load, B / F (median over repeats)",
    [
      "config",
      "published fps",
      "delivered fps/recv mean",
      "delivered min",
      "drawn fps/recv",
      "drops/recv (published − delivered)",
      "renderer superseded (2d)",
      "main ELD p99 ms",
      "main ELD max ms",
      "rAF mean ms",
      "rAF max ms",
      "onFrame max depth",
      "producer upload p99 ms",
    ],
    keys.map((k) => {
      const g = groups.get(k);
      return [
        k,
        pair(g, "pubFps", f1),
        pair(g, "dlv", f1),
        pair(g, "dlvMin", f1),
        pair(g, "drawn", f1),
        pair(g, "drops", f1),
        pair(g, "superseded", f1),
        pair(g, "eldP99", f2),
        pair(g, "eldMax", f1),
        pair(g, "rafMean", f1),
        pair(g, "rafMax", f1),
        pair(g, "depth", f1),
        pair(g, "upP99", f1),
      ];
    }),
  );
  const heavy = okRuns
    .filter((r) => r.config.W === 3840 && r.config.N === 16)
    .sort((a, b) => (a.meta?.runIndex ?? 0) - (b.meta?.runIndex ?? 0));
  table(
    "4K N=16, every run (in run order)",
    [
      "run",
      "config",
      "rep",
      "imports/frame",
      "pub→import mean",
      "pub→T_rx mean / p95",
      "pub→T_draw or GPU done mean",
      "published fps",
      "delivered fps/recv",
      "drawn fps/recv",
      "superseded",
      "main ELD p99 / max",
      "rAF mean / max",
      "max depth",
    ],
    heavy.map((r) => [
      `${r.meta?.runIndex ?? "?"}`,
      `${r.config.PIPE}/${cfgKey(r.config)}`,
      `${r.meta?.rep ?? 1}`,
      f2(metric.impPerFrame(r)),
      f2(metric.pubImp(r)),
      `${f2(metric.rx(r))} / ${f2(metric.rxP95(r))}`,
      r.config.DRAW === "webgpu" ? f1(metric.gpu(r)) : f2(metric.draw(r)),
      f1(r.publishedFps),
      f1(r.deliveredFps.mean),
      f1(r.drawnFps.mean),
      `${r.rendererSuperseded}`,
      `${f2(r.eventLoopDelayMs.p99)} / ${f1(r.eventLoopDelayMs.max)}`,
      `${f1(r.rafIntervalMs.mean)} / ${f1(r.rafIntervalMs.max)}`,
      `${r.rendererInWindow.maxDepth}`,
    ]),
  );
  const bad = all.filter((r) => r.error);
  if (bad.length) {
    console.log("\n### Failed runs\n");
    for (const r of bad) console.log(`- ${r.config.PIPE}/${cfgKey(r.config)}: ${r.error}`);
  }
  const fwdFail = okRuns.filter((r) => r.mainF && Object.keys(r.mainF.forwardFailures).length);
  for (const r of fwdFail)
    console.log(
      `- forward failures ${cfgKey(r.config)}: ${JSON.stringify(r.mainF.forwardFailures)}`,
    );
};

if (FANOUT) {
  const all = files.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)),
  );
  printFanout(all);
  process.exit(0);
}

const failed = rows.filter((r) => r.error);
const ok = rows.filter((r) => !r.error);
const A = ok.filter((r) => r.config.PIPE === "A");

table(
  "A: main-side stages (mean / p95 / p99 ms)",
  [
    "config",
    "pub→cb",
    "cb→dequeue (latest-wins wait)",
    "import",
    "sendSharedTexture call",
    "send→ack (IPC RTT)",
    "ack − T_rx",
  ],
  A.map((r) => [
    key(r.config),
    cell(r.stages.pub_cb),
    cell(r.stages.cb_dequeue),
    cell(r.stages.import),
    cell(r.stages.sendCall),
    cell(r.stages.send_ack),
    cell(r.stages.ack_minus_rx),
  ]),
);

table(
  "A: renderer stages (mean / p95 / p99 ms)",
  [
    "config",
    "send→T_rx",
    "T_rx→rAF (2d)",
    "draw CPU",
    "T_rx→T_draw",
    "submit→GPU done",
    "total pub→T_rx",
    "total pub→T_draw",
    "total pub→GPU done",
  ],
  A.map((r) => [
    key(r.config),
    cell(r.stages.send_rx),
    cell(r.stages.rx_raf),
    cell(r.stages.draw_cpu),
    cell(r.stages.rx_draw),
    cell(r.stages.submit_gpuDone),
    cell(r.stages.totalSeq_pub_rx),
    cell(r.stages.totalSeq_pub_draw),
    cell(r.stages.totalSeq_pub_gpu),
  ]),
);

table(
  "A vs B totals, latest-pub matching for both (mean / p95 / p99 ms)",
  ["config", "pub→T_rx A", "pub→T_rx B", "pub→T_draw A", "pub→T_draw B", "pub→GPU A", "pub→GPU B"],
  [...new Set(ok.map((r) => key({ ...r.config, PIPE: "*" })))].map((k) => {
    const a = ok.find((r) => key({ ...r.config, PIPE: "*" }) === k && r.config.PIPE === "A");
    const b = ok.find((r) => key({ ...r.config, PIPE: "*" }) === k && r.config.PIPE === "B");
    return [
      k.replace("*/", ""),
      cell(a?.stages.totalLatestPub_pub_rx),
      cell(b?.stages.totalLatestPub_pub_rx),
      cell(a?.stages.totalLatestPub_pub_draw),
      cell(b?.stages.totalLatestPub_pub_draw),
      cell(a?.stages.totalLatestPub_pub_gpu),
      cell(b?.stages.totalLatestPub_pub_gpu),
    ];
  }),
);

table(
  "Throughput, drops, main event loop, renderer",
  [
    "config",
    "published fps",
    "native cb fps/recv (A)",
    "native ring drops/recv (A)",
    "delivered fps/recv mean (min)",
    "drawn fps/recv",
    "main latest-wins drops/recv (A)",
    "renderer superseded (2d, total)",
    "ring-held warnings",
    "main ELD p50 / p99 / max ms",
    "rAF interval mean / p99 / max ms",
    "onFrame max depth / max live VideoFrames",
    "producer upload mean / p99 ms",
  ],
  ok.map((r) => {
    const depth = r.rendererInWindow.maxDepth;
    const live = r.rendererInWindow.maxLive;
    return [
      key(r.config),
      f1(r.publishedFps),
      f1(r.mainA?.callbacksPerReceiverFps),
      f1(r.mainA?.nativeDropsPerReceiver),
      `${f1(r.deliveredFps.mean)} (${f1(r.deliveredFps.min)})`,
      f1(r.drawnFps.mean),
      f1(r.mainA?.mainLatestWinsDropsPerReceiver),
      `${r.rendererSuperseded}`,
      `${r.ringHeldWarnings}`,
      `${f2(r.eventLoopDelayMs.p50)} / ${f2(r.eventLoopDelayMs.p99)} / ${f1(r.eventLoopDelayMs.max)}`,
      `${f1(r.rafIntervalMs.mean)} / ${f1(r.rafIntervalMs.p99)} / ${f1(r.rafIntervalMs.max)}`,
      `${depth} / ${live}`,
      `${f2(r.producerUploadMs.mean)} / ${f1(r.producerUploadMs.p99)}`,
    ];
  }),
);

if (failed.length) {
  console.log("\n### Failed configurations\n");
  for (const r of failed) console.log(`- ${key(r.config)}: ${r.error}`);
}
