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

const { Worker, isMainThread } = require('worker_threads');

// Worker threads inherit process.execArgv by default — including this
// very `--require ./startup-watchdog.preload.js` flag. Without this
// guard, the kill-worker created below re-runs this whole file as part
// of ITS OWN bootstrap (before its eval'd task ever executes), which
// creates another worker, which does the same, recursively — confirmed
// empirically: instrumented isMainThread/threadId, saw a genuine chain of
// 100+ distinct worker threads (not a replay of one worker — every
// threadId was unique and incrementing) spin up in ~2s. Each of those
// nested preload runs sets its OWN `global.__clearStartupWatchdog` on
// its OWN isolated worker global (worker_threads don't share a global
// object with the main thread or each other), so the real
// __clearStartupWatchdog call from main.ts — which only ever reaches the
// main thread's own copy — can never cancel any of them. Every nested
// kill-worker is an orphaned timer nobody can stop, independently armed
// to SIGKILL the whole process (they all target the same pid) once ITS
// OWN TIMEOUT_MS elapses, whether or not the app is healthy and serving
// traffic by then. This guard being the very first thing this file does
// is what stops the chain — a nested worker still inherits `--require`
// and still re-runs this file, but immediately hits this check and
// returns before doing anything else, including before it would create a
// further nested worker. Confirmed this alone is sufficient (no need to
// also strip execArgv on the Worker below): 15s run with this guard but
// no execArgv override showed exactly one extra `isMainThread=false`
// instrumentation hit, never a second one — the chain is cut to a single
// harmless bounce, not zero, but zero further recursion either way. This
// also covers any OTHER worker thread the app itself spawns (e.g. from a
// dependency's SDK) that inherits `--require` — it would hit this same
// guard immediately too.
//
// Deliberately NOT also passing `execArgv: []` to the Worker below, even
// though that would strip the inheritance at the source and looks like
// stronger defense in depth: verified empirically that explicitly setting
// `execArgv` on a Worker — even to `[]` — silently defeats
// --report-exclude-env for the ENTIRE process, not just that worker
// (reproduced directly: a preload whose only job is `new Worker(x, {
// execArgv: [] })` was enough to make secrets reappear in a report
// generated afterward, with no exclude-env warning or error of any kind).
// Since this app is started with --report-exclude-env specifically to
// keep DATABASE_URL/JWT_SECRET/REDIS_URL out of any diagnostic report
// written to a persistent host path, that trade is not worth it — the
// isMainThread guard alone already fully stops the recursion.
if (!isMainThread) {
  return;
}

console.log(`[startup] ${Date.now()} preload loaded pid=${process.pid}`);

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
// having. Originally tried as a second worker_thread instead of a plain
// setTimeout; that produced what looked like the same worker's top-level
// script replaying from scratch hundreds of times over a real ~40s wait,
// defeating even a shared-memory idempotency guard. Root cause (see the
// isMainThread guard above): it wasn't a replay of one worker at all — it
// was a genuine, unbounded chain of distinct nested workers, each
// inheriting `--require` via execArgv and re-running this file before its
// actual task, each spawning the next. Fixed at the source now (the
// isMainThread guard above — see its comment for why execArgv: [] was
// tried and dropped), so a second worker_thread would presumably be safe
// today, but there's no reason to add one back: this setTimeout costs
// nothing extra (see above) and keeps the kill-worker's shape identical
// to the already-reviewed PR #8 design.
const REPORT_LEAD_MS = 5000;
// SIGUSR2's default disposition (no handler installed) is to terminate
// the process — only safe to self-send here because --report-on-signal
// --report-signal=SIGUSR2 installs a handler for it that turns the signal
// into a report instead. Only schedule the send when that flag is
// actually present in this process's own execArgv, so anywhere the
// backend gets started without it (a future flag typo, some other
// invocation path) this timer is simply inert rather than a delayed
// self-kill of an otherwise-healthy process.
const hasReportOnSignal = process.execArgv.includes('--report-on-signal');
const reportTimer = hasReportOnSignal
  ? setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGUSR2');
        console.log(
          `[startup-watchdog] ${TIMEOUT_MS - REPORT_LEAD_MS}ms without a successful listen() — sent SIGUSR2 for a diagnostic report`
        );
      } catch (e) {
        console.log(`[startup-watchdog] SIGUSR2 send failed: ${e.message}`);
      }
    }, Math.max(0, TIMEOUT_MS - REPORT_LEAD_MS))
  : null;
if (reportTimer) {
  reportTimer.unref();
}

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
  {
    eval: true,
    // No execArgv override here — see the isMainThread guard's comment
    // above for why (it defeats --report-exclude-env process-wide). The
    // guard alone is what stops this worker's inherited --require from
    // recursing.
    workerData: { sharedBuffer, timeoutMs: TIMEOUT_MS, pid: process.pid },
  }
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
  // a healthy process). Originally this was the only thing standing
  // between a healthy backend and a delayed self-kill wherever
  // --report-on-signal isn't set (SIGUSR2's default disposition is to
  // terminate) — reproduced that kill directly before adding this. The
  // hasReportOnSignal check above now means reportTimer is simply null in
  // that case, so this is defense in depth, not the only thing stopping
  // it. clearTimeout(null) is a documented no-op, safe either way.
  clearTimeout(reportTimer);
  console.log(`[startup-watchdog] cleared — backend is listening`);
};
