// cpu.js — how many CPUs this process may actually use.
//
// os.cpus() reports the HOST machine's cores, not this container's CPU quota.
// Inside a 0.5-CPU instance it will happily report 32+, and any caller that
// sizes a thread pool from it spawns 32 V8 isolates — each with its own heap —
// into a 512MB box. That is a boot-time OOM, not a slow leak: the process dies
// inside init() before it ever binds a port, and the platform serves 502s with
// nothing in the app's own logs to explain it.
//
// So: read the cgroup quota first, fall back to os.cpus() only when genuinely
// unconstrained, and let an operator override either way without a release.
"use strict";

const os = require("os");
const fs = require("fs");

// Effective CPU allowance from the cgroup, in (possibly fractional) CPUs.
// null means "no quota set, or not readable" — the caller falls back to os.cpus().
//
//   cgroup v2  /sys/fs/cgroup/cpu.max                    → "<quota|max> <period>"
//   cgroup v1  cpu.cfs_quota_us / cpu.cfs_period_us      (quota -1 = unlimited)
function cgroupCpuQuota() {
  try {
    const parts = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (parts.length === 2) {
      if (parts[0] === "max") return null; // v2, explicitly unconstrained
      const quota = Number(parts[0]), period = Number(parts[1]);
      if (quota > 0 && period > 0) return quota / period;
    }
  } catch { /* not cgroup v2 — fall through to v1 */ }

  try {
    const quota  = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_quota_us",  "utf8"));
    const period = Number(fs.readFileSync("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "utf8"));
    // An unlimited v1 quota is -1, which `> 0` already excludes.
    if (quota > 0 && period > 0) return quota / period;
  } catch { /* not cgroup v1 either — nothing to read */ }

  return null;
}

// How many workers/threads it is safe to spawn here. Always >= 1, and never
// more than the host actually has. KALAIROS_MAX_WORKERS wins outright so an
// operator can pin the number from the dashboard during an incident.
function availableCpus() {
  const override = Number(process.env.KALAIROS_MAX_WORKERS);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);

  const hostCpus = Math.max(1, os.cpus().length);
  const quota    = cgroupCpuQuota();
  if (quota === null) return hostCpus;

  // Round a fractional quota up: half a CPU still gets one worker, not zero.
  return Math.max(1, Math.min(hostCpus, Math.ceil(quota)));
}

module.exports = { availableCpus, cgroupCpuQuota };
