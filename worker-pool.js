// worker-pool.js — Persistent worker thread pool for parallel scoring
"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const { availableCpus } = require("./cpu");
const { Err, emitError } = require("./errors");

const WORKER_FILE = path.resolve(__dirname, "worker.js");

// How many jobs may wait for a free worker before run() starts rejecting.
//
// A query dispatches one job per worker, so this is tens of queries deep —
// enough to absorb a burst, small enough that a stalled pool surfaces as an
// error instead of as unbounded memory. It is bounded at all because a queued
// job pins its whole `msg`: one chunk of candidate entities, each carrying its
// full text and its full embedding vector. Measured at ~11MB per queued job on
// a 400-entity store. 25 of them stuck behind a dead pool retained 285MB.
const DEFAULT_QUEUE_MAX = Number(process.env.KALAIROS_WORKER_QUEUE_MAX || 256);

// A worker that dies is replaced rather than written off, because the likely
// cause is an OOM kill on a small container — see cpu.js for why that is the
// expected failure here and not an exotic one. The budget is what stops a
// worker that crashes on startup from being respawned in a tight loop forever.
const DEFAULT_MAX_RESPAWNS = Number(process.env.KALAIROS_WORKER_MAX_RESPAWNS || 32);

class WorkerPool {
  // Default to what this container may actually use. os.cpus() would report the
  // host's cores — see cpu.js for why that OOMs a small instance at boot.
  constructor(size = availableCpus(), {
    queueMax    = DEFAULT_QUEUE_MAX,
    maxRespawns = DEFAULT_MAX_RESPAWNS,
  } = {}) {
    this._size    = size;
    this._workers = []; // [{ worker, pending: {resolve, reject} | null } | null] — null = dead slot
    this._idle    = []; // indices of LIVE workers waiting for work
    this._queue   = []; // { msg, resolve, reject } — jobs waiting for a free worker

    this._queueMax    = queueMax;
    this._maxRespawns = maxRespawns;
    this._respawns    = 0;
    this._stopping    = false;
  }

  // Spawn all workers. Call once at init().
  start() {
    this._stopping = false;
    for (let i = 0; i < this._size; i++) {
      this._workers[i] = null;
      this._spawn(i);
    }
  }

  // Dispatch a scoring job to the next free worker, or queue it.
  run(msg) {
    return new Promise((resolve, reject) => {
      if (this._stopping) {
        return reject(emitError(Err.workerFailed("pool is shutting down")));
      }
      if (this._idle.length) {
        return this._dispatch(this._idle.shift(), msg, resolve, reject);
      }
      // Nothing alive will ever pick this up. Fail now rather than queue a
      // chunk that no one can drain — that wait is unbounded, and the caller
      // holds its whole continuation (in the server, the request and response
      // objects too) for as long as it lasts.
      if (!this._liveCount()) {
        return reject(emitError(Err.workerFailed("no live workers in pool")));
      }
      if (this._queue.length >= this._queueMax) {
        return reject(emitError(Err.workerQueueFull(this._queue.length, this._queueMax)));
      }
      this._queue.push({ msg, resolve, reject });
    });
  }

  // Terminate all workers. Call at shutdown().
  async stop() {
    this._stopping = true;

    // Settle waiting callers before tearing anything down. Clearing _queue
    // without settling it freed the payloads but left every awaiting caller
    // hanging forever on a promise nothing would ever resolve.
    this._failQueue(Err.workerFailed("pool stopped before the job ran"));

    for (const slot of this._workers) {
      if (slot?.pending) {
        slot.pending.reject(emitError(Err.workerFailed("pool stopped while the job was in flight")));
        slot.pending = null;
      }
      if (slot?.worker) await slot.worker.terminate().catch(() => {});
    }
    this._workers = [];
    this._idle    = [];
    this._queue   = [];
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  _spawn(idx) {
    const w = new Worker(WORKER_FILE);
    this._workers[idx] = { worker: w, pending: null };
    this._idle.push(idx);

    // Every handler first checks that slot `idx` still belongs to THIS worker.
    // A replaced worker can still emit: without the guard, a dead worker's late
    // 'exit' would null out the live worker that took its place, and its late
    // 'message' would settle that worker's job with the wrong results.
    const isCurrent = () => this._workers[idx]?.worker === w;

    w.on("message", msg  => { if (isCurrent()) this._onMessage(idx, msg); });
    w.on("error",   err  => { if (isCurrent()) this._onError(idx, err); });
    w.on("exit",    code => { if (isCurrent()) this._onExit(idx, code); });

    // An idle worker must not keep the process alive, or a script that calls
    // init() and query() but never shutdown() hangs after its last line.
    // _dispatch refs the worker for the life of a job, so an in-flight query
    // still holds the process open until it settles. This has to come after
    // the 'message' listener: attaching one re-refs the worker's port.
    w.unref();
  }

  _dispatch(idx, msg, resolve, reject) {
    const slot = this._workers[idx];
    // Defensive: _idle should now only ever hold live slots. It did not always,
    // and the symptom was "Cannot set properties of null (setting 'pending')".
    if (!slot) return reject(emitError(Err.workerFailed(`worker ${idx} is not alive`)));
    slot.pending = { resolve, reject };
    slot.worker.ref();
    slot.worker.postMessage(msg);
  }

  _onMessage(idx, msg) {
    // A reply that lands while stop() is terminating this worker changes
    // nothing: stop() has already settled the job. Unref'ing the worker here
    // would let the process exit before the worker does, so stop(), and the
    // rest of shutdown() after it, would never finish.
    if (this._stopping) return;
    const slot    = this._workers[idx];
    const pending = slot?.pending ?? null; // a worker may emit with no job in flight
    if (slot) {
      slot.pending = null;
      slot.worker.unref();
      this._idle.push(idx);
    }
    this._drain();
    if (!pending) return;
    if (msg?.ok) pending.resolve(msg.results || []);
    else         pending.reject(new Error(msg?.error || "Worker error"));
  }

  _onError(idx, err) {
    const slot    = this._workers[idx];
    const pending = slot?.pending ?? null;
    if (slot) slot.pending = null;
    // Deliberately not re-queued as idle here. In worker_threads an 'error' is
    // followed by an 'exit', so this worker is on its way out; advertising it
    // as idle is how jobs used to get dispatched into a dying thread. _onExit
    // owns the recovery decision.
    if (pending) pending.reject(err);
  }

  _onExit(idx, code) {
    const slot = this._workers[idx];
    this._workers[idx] = null;
    this._removeIdle(idx);

    // Nobody else can finish what this worker was holding.
    if (slot?.pending) {
      slot.pending.reject(emitError(Err.workerFailed(`worker ${idx} exited unexpectedly (code ${code})`)));
    }

    if (this._stopping) return;

    if (this._respawns < this._maxRespawns) {
      this._respawns++;
      this._spawn(idx);
      this._drain();
      return;
    }

    // Respawn budget spent. If nothing is left alive, everything queued is
    // unrunnable — fail it now instead of holding it, and its chunks, forever.
    if (!this._liveCount()) {
      this._failQueue(Err.workerFailed(
        `all workers died and the respawn budget (${this._maxRespawns}) is exhausted`));
    }
  }

  _drain() {
    while (this._queue.length && this._idle.length) {
      const idx = this._idle.shift();
      if (!this._workers[idx]) continue; // slot died between being queued and now
      const { msg, resolve, reject } = this._queue.shift();
      this._dispatch(idx, msg, resolve, reject);
    }
  }

  _failQueue(err) {
    if (!this._queue.length) return;
    const queued = this._queue.splice(0);
    emitError(err); // one signal for the batch — not one per abandoned job
    for (const job of queued) job.reject(err);
  }

  _removeIdle(idx) {
    const at = this._idle.indexOf(idx);
    if (at >= 0) this._idle.splice(at, 1);
  }

  _liveCount() {
    let n = 0;
    for (const slot of this._workers) if (slot) n++;
    return n;
  }
}

module.exports = { WorkerPool };
