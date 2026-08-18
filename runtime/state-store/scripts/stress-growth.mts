/**
 * Growth stress test for the root runtime DB.
 *
 * Answers one question: what actually degrades as a workspace accumulates
 * sessions, turns, traces and artifacts — and at roughly what size.
 *
 * It writes through the REAL store API (appendOutputEvent,
 * upsertTurnRequestSnapshot, createOutput), so it exercises the production
 * schema, indexes and triggers rather than a hand-rolled approximation. Payload
 * sizes are taken from a real desktop workspace:
 *
 *   pi_native_event          ~700 B typical, up to 110 KB
 *   turn_request_snapshots   ~204 KB per TURN — the biggest single row class
 *   thinking/output deltas   ~100 B, but thousands per turn
 *
 * Then it measures the operations that a bloated DB makes slow, in the order a
 * user meets them:
 *
 *   PRAGMA quick_check   the boot integrity check — the operation that once
 *                        took 80s on a 1.9GB DB and livelocked the app
 *   history page load    what the chat pane runs to paint a conversation
 *   retention sweep      the background prune, which must stay bounded
 *
 * Usage:
 *   node --import tsx scripts/stress-growth.mts [--sessions N] [--turns N]
 *                                               [--events N] [--keep]
 *
 * Everything is written to a throwaway directory and deleted unless --keep.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeStateStore } from "../src/store.js";

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SESSIONS = arg("sessions", 20);
const TURNS_PER_SESSION = arg("turns", 25);
const EVENTS_PER_TURN = arg("events", 120);
const KEEP = process.argv.includes("--keep");

const WS = "root";
// Sized from real data rather than invented.
const SNAPSHOT_BYTES = 204 * 1024;
const NATIVE_EVENT_BYTES = 700;
const BIG_NATIVE_EVENT_BYTES = 110 * 1024;
const DELTA_BYTES = 100;

function filler(bytes: number): string {
  return "x".repeat(Math.max(1, bytes));
}

function ms(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function fmtBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-stress-"));
const store = new RuntimeStateStore({
  dbPath: path.join(root, "host-state.db"),
  workspaceRoot: path.join(root, "workspace"),
});
const dbPath = store.rootRuntimeDbPath; // derived by the store, not guessed

console.log(
  `populating: ${SESSIONS} sessions x ${TURNS_PER_SESSION} turns x ${EVENTS_PER_TURN} events`,
);

const writeStarted = process.hrtime.bigint();
let eventCount = 0;
for (let s = 0; s < SESSIONS; s += 1) {
  const sessionId = `stress-session-${s}`;
  for (let t = 0; t < TURNS_PER_SESSION; t += 1) {
    const inputId = `${sessionId}-input-${t}`;
    let sequence = 0;
    // The per-turn request snapshot: one row, but the largest row class there
    // is, and nothing ever deletes it.
    store.upsertTurnRequestSnapshot({
      workspaceId: WS,
      sessionId,
      inputId,
      snapshotKind: "request",
      fingerprint: `fp-${s}-${t}`,
      payload: { prompt: filler(SNAPSHOT_BYTES) },
    });
    for (let e = 0; e < EVENTS_PER_TURN; e += 1) {
      sequence += 1;
      // Roughly the real mix: mostly small deltas, a steady drip of native
      // events, and an occasional very large one.
      const isNative = e % 3 === 0;
      const isBig = e % 60 === 0;
      const size = isBig
        ? BIG_NATIVE_EVENT_BYTES
        : isNative
          ? NATIVE_EVENT_BYTES
          : DELTA_BYTES;
      store.appendOutputEvent({
        workspaceId: WS,
        sessionId,
        inputId,
        sequence,
        eventType: isNative ? "pi_native_event" : "output_delta",
        payload: { data: filler(size) },
      });
      eventCount += 1;
    }
  }
  if ((s + 1) % 5 === 0) {
    process.stdout.write(`  ${s + 1}/${SESSIONS} sessions\n`);
  }
}
const writeMs = ms(writeStarted);
store.close();

const sizeBytes = fs.statSync(dbPath).size;
console.log(
  `\nwrote ${eventCount.toLocaleString()} events + ${(SESSIONS * TURNS_PER_SESSION).toLocaleString()} snapshots in ${(writeMs / 1000).toFixed(1)}s`,
);
console.log(`data.db: ${fmtBytes(sizeBytes)}\n`);

// ── The operations a bloated DB makes slow ────────────────────────────────────
const reopened = new RuntimeStateStore({
  dbPath: path.join(root, "host-state.db"),
  workspaceRoot: path.join(root, "workspace"),
});

// 1. The boot integrity check. Only runs after an unclean exit, but when it does
//    it is unbounded in DB size and the desktop gives the runtime ~30s to answer
//    /healthz before killing it — the livelock.
const checkStarted = process.hrtime.bigint();
const rawDb = (reopened as unknown as { rootRuntimeDb(): { pragma(q: string): unknown } });
let quickCheckMs = -1;
try {
  const db = rawDb.rootRuntimeDb();
  db.pragma("quick_check");
  quickCheckMs = ms(checkStarted);
} catch (error) {
  console.log(`quick_check unavailable: ${(error as Error).message}`);
}

// 2. Painting a conversation: the newest page of one session's history.
const readStarted = process.hrtime.bigint();
const events = reopened.listOutputEvents({
  workspaceId: WS,
  sessionId: `stress-session-${SESSIONS - 1}`,
  includeHistory: true,
});
const readMs = ms(readStarted);

// 3. ONE BATCH of the retention sweep. The real sweep loops these batches until
//    it converges (db-maintenance.ts), deliberately yielding between them so it
//    never holds the write lock; this measures the per-batch cost, which is what
//    must stay small.
const sweepStarted = process.hrtime.bigint();
const pruned = reopened.trimRootOutputEventsToTotal({ keep: 250_000, limit: 5_000 });
const sweepMs = ms(sweepStarted);

// 4. Snapshot retention — the axis that had none until now.
const snapshotsBefore = reopened.countRootTurnRequestSnapshots();
const snapStarted = process.hrtime.bigint();
let snapPruned = 0;
for (;;) {
  const deleted = reopened.trimRootTurnRequestSnapshotsToTotal({
    keep: 1_000,
    limit: 5_000,
  });
  if (deleted === 0) break;
  snapPruned += deleted;
}
const snapMs = ms(snapStarted);

const counted = reopened.countRootOutputEvents();
reopened.close();

console.log("operation                       time");
console.log("------------------------------------");
console.log(`PRAGMA quick_check          ${quickCheckMs.toFixed(0).padStart(7)} ms   <- boot, after an unclean exit`);
console.log(`load one session's events   ${readMs.toFixed(0).padStart(7)} ms   <- every conversation paint`);
console.log(`retention sweep, 1 batch    ${sweepMs.toFixed(0).padStart(7)} ms   <- background`);
console.log(`snapshot trim to 1,000      ${snapMs.toFixed(0).padStart(7)} ms   <- was unbounded before`);
console.log(`\nsnapshots: ${snapshotsBefore.toLocaleString()} -> ${(snapshotsBefore - snapPruned).toLocaleString()}`);
console.log(`events now: ${counted.toLocaleString()} (sweep removed ${pruned.toLocaleString()}), read ${events.length} rows`);
console.log(
  `\nper-turn cost: ${((sizeBytes / (SESSIONS * TURNS_PER_SESSION)) / 1024).toFixed(0)} KB/turn`,
);
console.log(
  `extrapolated: 1,000 turns ~ ${fmtBytes((sizeBytes / (SESSIONS * TURNS_PER_SESSION)) * 1000)}, 10,000 turns ~ ${fmtBytes((sizeBytes / (SESSIONS * TURNS_PER_SESSION)) * 10000)}`,
);

if (KEEP) {
  console.log(`\nkept: ${root}`);
} else {
  fs.rmSync(root, { recursive: true, force: true });
}
