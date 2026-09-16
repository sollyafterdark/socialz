// Loaded via `node --require` BEFORE main.js's own import graph resolves.
//
// This has to live outside main.ts: ES/CJS import statements are hoisted
// and resolved before any of a module's own top-level statements run, so
// a timer placed "at the top" of main.ts would still start only after
// every one of its imports (and their transitive imports) has already
// been pulled in and evaluated. A `--require` preload is the only way to
// get code running before that graph is touched at all.
//
// Root cause this guards (see PR description for the full trail): an
// ASYNC await deep in Nest's provider-construction phase
// (nestjs-temporal-core's TEMPORAL_CONNECTION factory ->
// NativeConnection.connect()) can hang indefinitely with no timeout of
// its own. Because it's a genuine `await` and not a synchronous block,
// the event loop stays alive the whole time — a plain setTimeout set up
// here will still fire on schedule.
//
// This does NOT cover a truly synchronous hang (e.g. an infinite loop
// during module evaluation, or a synchronous blocking I/O call) — that
// would freeze the event loop itself and no in-process timer, including
// this one, could fire. Nothing in this codebase's import graph does
// that as far as this investigation found, but the Docker healthcheck
// (plain TCP probe of 127.0.0.1:3000, external process) is the backstop
// for that class of failure regardless, since it runs outside this
// process entirely.

const START = Date.now();
const TIMEOUT_MS = Number(process.env.BACKEND_STARTUP_TIMEOUT_MS) || 120000;

const watchdog = setTimeout(() => {
  console.error(
    `[startup-watchdog] fired after ${Date.now() - START}ms without a successful listen() ` +
      `(BACKEND_STARTUP_TIMEOUT_MS=${TIMEOUT_MS}ms) — exiting so pm2 restarts the process`
  );
  process.exit(1);
}, TIMEOUT_MS);

// Never let this timer be the reason the process stays alive — the app
// listening is what should do that.
watchdog.unref();

global.__clearStartupWatchdog = () => {
  clearTimeout(watchdog);
  console.log(`[startup-watchdog] cleared after ${Date.now() - START}ms — backend is listening`);
};
