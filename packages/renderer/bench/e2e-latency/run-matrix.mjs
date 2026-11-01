// Runs e2e-latency/main.mjs over a configuration matrix, one Electron process per config,
// and appends each RESULT line (plus native warning counts) to a JSONL file.
//
//   node packages/renderer/bench/e2e-latency/run-matrix.mjs <out.jsonl> [filter]
//   MATRIX=fanout REPEAT_4K16=3 node packages/renderer/bench/e2e-latency/run-matrix.mjs <out.jsonl> [filter]
//
// MATRIX=full (default) is the original A/B matrix + isolation runs. MATRIX=fanout is the
// receiver fan-out comparison: B (N receivers) vs F (1 receiver + N-1 forwardFrames) for
// DRAW none/2d/webgpu x 1080p/4K x N=1/4/16, with B and F interleaved per config (order flipped
// every other pair) to cancel drift; the 4K N=16 configs run REPEAT_4K16 times (default 3).
//
// `filter` is an optional substring matched against "PIPE/DRAW/WxH/N/WINDOWS" to run a subset,
// e.g. "A/2d/" or "/3840x2160/16". Each Electron run is started in its own process group
// (detached) and that group is SIGKILLed after the run, so only processes this script started
// are killed — never a broad `pkill` that could hit other Electron apps.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const electron = path.join(root, "packages/example/node_modules/.bin/electron");
const script = path.join(here, "main.mjs");
const [out, filter = ""] = process.argv.slice(2);
if (!out) throw new Error("usage: run-matrix.mjs <out.jsonl> [filter]");
const MATRIX = process.env.MATRIX ?? "full";
const REPEAT_4K16 = parseInt(process.env.REPEAT_4K16 ?? "3", 10);
const SIZES = [
  [1920, 1080],
  [3840, 2160],
];

const fullMatrix = () => {
  const configs = [];
  for (const PIPE of ["A", "B"]) {
    for (const DRAW of ["2d", "2d-immediate", "webgpu"]) {
      for (const [W, H] of SIZES) {
        for (const N of [1, 4, 16]) configs.push({ PIPE, DRAW, W, H, N, WINDOWS: 0 });
      }
    }
  }
  for (const N of [4, 16]) configs.push({ PIPE: "A", DRAW: "2d", W: 1920, H: 1080, N, WINDOWS: 1 });
  // Isolation runs: no draw at all, and an N=8 knee point at 4K.
  for (const N of [1, 16]) {
    for (const [W, H] of SIZES) configs.push({ PIPE: "A", DRAW: "none", W, H, N, WINDOWS: 0 });
  }
  for (const DRAW of ["none", "2d", "webgpu"])
    configs.push({ PIPE: "A", DRAW, W: 3840, H: 2160, N: 8, WINDOWS: 0 });
  return configs;
};

const fanoutMatrix = () => {
  const configs = [];
  const pair = (base, flip) => (flip ? ["F", "B"] : ["B", "F"]).map((PIPE) => ({ ...base, PIPE }));
  for (const DRAW of ["none", "2d", "webgpu"]) {
    for (const [W, H] of SIZES) {
      for (const N of [1, 4, 16]) {
        configs.push(...pair({ DRAW, W, H, N, WINDOWS: 0, rep: 1 }, configs.length % 4 === 2));
      }
    }
  }
  for (let rep = 2; rep <= REPEAT_4K16; rep++) {
    for (const DRAW of ["none", "2d", "webgpu"]) {
      configs.push(...pair({ DRAW, W: 3840, H: 2160, N: 16, WINDOWS: 0, rep }, rep % 2 === 0));
    }
  }
  return configs;
};

const key = (c) => `${c.PIPE}/${c.DRAW}/${c.W}x${c.H}/${c.N}/${c.WINDOWS}`;

/** Spawn Electron in its own process group, collect output, resolve on exit or timeout. */
const runOne = (env) =>
  new Promise((resolve) => {
    const child = spawn(electron, [script], { cwd: root, env, detached: true });
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    const timer = setTimeout(() => killGroup(child.pid), 150_000);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, status, signal, all: Buffer.concat(chunks).toString("utf8") });
    });
  });

/** SIGKILL every process left in the group `pgid` (Electron main + its helpers). */
const killGroup = (pgid) => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: group already gone
  }
};

const groupMembers = (pgid) =>
  spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
    .stdout.split("\n")
    .map((l) =>
      l
        .trim()
        .split(/\s+/)
        .map((x) => parseInt(x, 10)),
    )
    .filter(([pid, g]) => g === pgid && pid !== process.pid);

const configs = (MATRIX === "fanout" ? fanoutMatrix() : fullMatrix()).filter((c) =>
  key(c).includes(filter),
);

for (const [i, c] of configs.entries()) {
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(c)
        .filter(([k]) => k !== "rep")
        .map(([k, v]) => [k, `${v}`]),
    ),
  };
  const t0 = Date.now();
  const res = await runOne(env);
  killGroup(res.pid);
  spawnSync("sleep", ["0.5"]);
  const leftovers = groupMembers(res.pid);
  if (leftovers.length) killGroup(res.pid);
  const line = res.all.split("\n").find((l) => l.startsWith("RESULT "));
  const ringHeldWarnings = (res.all.match(/ring slots still held downstream/g) ?? []).length;
  const meta = {
    rep: c.rep ?? 1,
    runIndex: i,
    startedAt: new Date(t0).toISOString(),
    pid: res.pid,
  };
  const record = line
    ? { ...JSON.parse(line.slice(7)), ringHeldWarnings, exit: res.status, meta }
    : {
        config: c,
        error: `no RESULT (exit ${res.status}, signal ${res.signal})`,
        tail: res.all.slice(-800),
        meta,
      };
  appendFileSync(out, `${JSON.stringify(record)}\n`);
  console.log(
    `[${i + 1}/${configs.length}] ${key(c)} rep=${meta.rep} pid=${res.pid} exit=${res.status} ${((Date.now() - t0) / 1000).toFixed(1)}s leftovers=${leftovers.length} ${record.error ?? ""}`,
  );
  spawnSync("sleep", ["1"]);
}
