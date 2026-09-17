// Loaded via `node --require` BEFORE main.js's own import graph resolves.
//
// This has to live outside main.ts: ES/CJS import statements are hoisted
// and resolved before any of a module's own top-level statements run, so
// a timer placed "at the top" of main.ts would still start only after
// every one of its imports (and their transitive imports) has already
// been pulled in and evaluated. A `--require` preload is the only way to
// get code running before that graph is touched at all.
//
// UNCONFIRMED root cause note: the 2026-09-15/16 hang logs show nothing
// at all after pnpm's own start-command echo — not even Nest's very
// first log line. That means the hang could be in module loading itself
// (require/import resolution, before main.ts's start() ever runs),
// pre-Nest process startup (node/dotenv-cli), or later in Nest's own
// bootstrap (e.g. nestjs-temporal-core's TEMPORAL_CONNECTION factory,
// which calls the untimed NativeConnection.connect() during provider
// construction — see the backlog note in the PR description). We do not
// know which yet.
//
// That uncertainty is exactly why this watchdog is built the way it is:
// a plain setTimeout would only be reliable against an async hang (one
// where the event loop stays alive, just parked on a pending promise).
// If the actual hang is a genuinely SYNCHRONOUS block — an infinite
// loop, a blocking synchronous I/O call, anything that never yields back
// to the event loop — a setTimeout registered on that same main thread
// would never fire, because the event loop never gets a turn to run it.
//
// So the enforcement timer runs on a separate worker_thread instead of
// the main thread. Worker threads are real OS-level threads, each with
// its own independent event loop — the worker's Atomics.wait() call
// keeps ticking down on its own thread regardless of what the main
// thread's event loop is doing, including being fully frozen. When the
// wait times out, the worker calls process.kill(pid, 'SIGKILL') — SIGKILL
// is delivered by the OS kernel and cannot be caught, deferred, or
// ignored by any JS code, so it terminates the process even if the main
// thread never runs another line of JS again.

console.log(`[startup] ${Date.now()} preload loaded pid=${process.pid}`);

const { Worker } = require('worker_threads');

const TIMEOUT_MS = Number(process.env.BACKEND_STARTUP_TIMEOUT_MS) || 45000;

// How long before the SIGKILL deadline to request a diagnostic report via
// SIGUSR2 (node started with --report-on-signal --report-signal=SIGUSR2 —
// see apps/backend package.json "start"). Report generation is dispatched
// through libuv's signal-watcher, which only runs on the main thread's
// event loop — so is a plain setTimeout scheduling the SIGUSR2 send below.
// Verified empirically (throwaway container, node --report-on-signal
// against a `while(true){}` hang): sending SIGUSR2 produces NOTHING when
// the main thread is truly frozen synchronously, in JS or in a blocking
// native call/lock — the event loop never gets a turn to notice the
// pending signal, so the report callback never runs. The same mechanism
// against a healthy/responsive process does produce a report. That means
// a main-thread setTimeout costs us nothing here: it can only fail to
// fire in exactly the case (event loop frozen) where the report itself
// could never have been produced anyway, and it can't miss the async-hang
// case (event loop still turning) that's the one case this is worth
// having. Deliberately NOT a second worker_thread: verified empirically
// that a second worker racing the kill worker under a frozen main thread
// gets its whole top-level script replayed from scratch, hundreds of
// times over a real ~40s wait (an already-shared-memory idempotency guard
// included — each replay got a clean slate, so guarding against re-firing
// didn't work either) — a genuinely surprising Node behavior in this
// specific "`--require`-spawned worker racing a frozen main thread"
// scenario that we don't have a full root cause for. A single worker
// (below) doesn't exhibit it, which is what the original PR #8 design
// already relies on and what's kept unchanged here.
const REPORT_LEAD_MS = 5000;
const reportTimer = setTimeout(() => {
  try {
    process.kill(process.pid, 'SIGUSR2');
    console.log(
      `[startup-watchdog] ${TIMEOUT_MS - REPORT_LEAD_MS}ms without a successful listen() — sent SIGUSR2 for a diagnostic report`
    );
  } catch (e) {
    console.log(`[startup-watchdog] SIGUSR2 send failed: ${e.message}`);
  }
}, Math.max(0, TIMEOUT_MS - REPORT_LEAD_MS));
reportTimer.unref();

// Shared, not a regular ArrayBuffer: both threads see writes to this
// memory immediately, which is what Atomics.wait/notify rely on.
const sharedBuffer = new SharedArrayBuffer(4);
const flag = new Int32Array(sharedBuffer);
Atomics.store(flag, 0, 0);

const worker = new Worker(
  `
  const fs = require('fs');
  const { workerData } = require('worker_threads');
  const flag = new Int32Array(workerData.sharedBuffer);
  // Blocks THIS thread only, for up to timeoutMs, until index 0 stops
  // being 0 (i.e. until the main thread calls Atomics.store + notify)
  // or the timeout elapses. Runs independently of the main thread's
  // event loop entirely.
  const result = Atomics.wait(flag, 0, 0, workerData.timeoutMs);
  if (result === 'timed-out') {
    // process.stderr.write() from a worker thread is proxied to the main
    // thread (the real fd write happens there) and blocks waiting for
    // that round trip. Verified empirically: with the main thread frozen
    // in a synchronous loop, process.stderr.write() from the worker never
    // returns, so the process.kill() that used to follow it never ran —
    // this is why "fired" never appeared in the 2026-09-16 logs, and
    // (per the isolated repro) the SIGKILL below was reached anyway only
    // because in production node isn't pid 1 in its own namespace, not
    // because this write returned. fs.writeSync(2, ...) writes straight
    // to the real fd from the worker's own thread, no main-thread
    // cooperation needed, and returns immediately either way.
    fs.writeSync(
      2,
      '[startup-watchdog] fired after ' + workerData.timeoutMs +
        'ms without a successful listen() (BACKEND_STARTUP_TIMEOUT_MS=' +
        workerData.timeoutMs + 'ms) — killing pid ' + workerData.pid +
        ' with SIGKILL\\n'
    );
    process.kill(workerData.pid, 'SIGKILL');
  }
  `,
  { eval: true, workerData: { sharedBuffer, timeoutMs: TIMEOUT_MS, pid: process.pid } }
);

// Don't let this worker be a reason the process stays alive on its own —
// the app listening is what should do that. The worker's own OS thread
// keeps running regardless of unref(); this only affects whether Node's
// main-thread event loop treats the handle as keeping the process open.
worker.unref();

global.__clearStartupWatchdog = () => {
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  // Without this, a successfully-started backend would still get an
  // unsolicited SIGUSR2 ~REPORT_LEAD_MS before whatever TIMEOUT_MS was —
  // harmless with --report-on-signal active (just an unnecessary report on
  // a healthy process), but SIGUSR2's default disposition is to terminate
  // the process, so anywhere that flag isn't set (a local `pnpm run start`
  // outside the container, say) this would silently kill an already-healthy
  // backend. Verified: reproduced the kill, confirmed clearTimeout fixes it.
  clearTimeout(reportTimer);
  console.log(`[startup-watchdog] cleared — backend is listening`);
};
