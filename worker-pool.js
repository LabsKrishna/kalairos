// worker-pool.js — Persistent worker thread pool for parallel scoring
"use strict";

const { Worker } = require("worker_threads");
const path = require("path");
const { availableCpus } = require("./cpu");

const WORKER_FILE = path.resolve(__dirname, "worker.js");

class WorkerPool {
  // Default to what this container may actually use. os.cpus() would report the
  // host's cores — see cpu.js for why that OOMs a small instance at boot.
  constructor(size = availableCpus()) {
    this._size    = size;
    this._workers = []; // [{ worker, pending: { resolve, reject } | null }]
    this._idle    = []; // indices of workers waiting for work
    this._queue   = []; // { msg, resolve, reject } — jobs waiting for a free worker
  }

  // Spawn all workers. Call once at init().
  start() {
    for (let i = 0; i < this._size; i++) {
      const w = new Worker(WORKER_FILE);
      this._workers.push({ worker: w, pending: null });
      this._idle.push(i);

      w.on("message", msg => this._onMessage(i, msg));
      w.on("error",   err => this._onError(i, err));
      w.on("exit", code => {
        // Unexpected exit — reject any pending job and remove the slot
        const p = this._workers[i]?.pending;
        if (p) p.reject(new Error(`Worker ${i} exited unexpectedly (code ${code})`));
        this._workers[i] = null;
      });
    }
  }

  // Dispatch a scoring job to the next free worker, or queue it.
  run(msg) {
    return new Promise((resolve, reject) => {
      if (this._idle.length) {
        const idx = this._idle.shift();
        this._dispatch(idx, msg, resolve, reject);
      } else {
        this._queue.push({ msg, resolve, reject });
      }
    });
  }

  // Terminate all workers. Call at shutdown().
  async stop() {
    for (const slot of this._workers) {
      if (slot?.worker) await slot.worker.terminate().catch(() => {});
    }
    this._workers = [];
    this._idle    = [];
    this._queue   = [];
  }

  _dispatch(idx, msg, resolve, reject) {
    this._workers[idx].pending = { resolve, reject };
    this._workers[idx].worker.postMessage(msg);
  }

  _onMessage(idx, msg) {
    const { resolve, reject } = this._workers[idx].pending;
    this._workers[idx].pending = null;
    this._idle.push(idx);
    this._drain();
    if (msg?.ok) resolve(msg.results || []);
    else         reject(new Error(msg?.error || "Worker error"));
  }

  _onError(idx, err) {
    const p = this._workers[idx].pending;
    this._workers[idx].pending = null;
    this._idle.push(idx);
    this._drain();
    if (p) p.reject(err);
  }

  _drain() {
    while (this._queue.length && this._idle.length) {
      const idx = this._idle.shift();
      const { msg, resolve, reject } = this._queue.shift();
      this._dispatch(idx, msg, resolve, reject);
    }
  }
}

module.exports = { WorkerPool };
