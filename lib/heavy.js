// dsh-geo-toolkit / lib/heavy.js
// 重操作隔离层：所有吃 native 内存的活（resvg 光栅化、PSD 写入）都丢进 worker 线程。
//
// 为什么必须隔离（2026-11-02 事故复盘）：
//  - @napi-rs/canvas / @resvg 的内存分配在 V8 堆外，--max-old-space-size 管不到；
//    一旦失控，整台机器的渲染进程都会被拖垮（当天 DSH renderer 直接 oom）。
//  - worker 有独立的 resourceLimits，terminate() 后 native 内存整块回收。
//
// 三条护栏：
//  1. 单任务内存上限（resourceLimits，默认 256MB V8 堆；native 峰值由任务尺寸控制）
//  2. 超时强杀（默认 120s）
//  3. 主进程并发锁：同一时刻只跑一个重任务，排队而不是并发
//
// 2026-11-02 实测补充：**每次新建 worker 会让 RSS 线性涨 20MB**（native 库每个 worker
// 重新申请一份内存，terminate 后 RSS 不归还）。所以这里改成**常驻 worker 复用**：
//  - 空闲 60 秒自动 terminate（不占内存）
//  - 每跑 30 个任务强制重建（防缓慢泄漏）
//  - worker 崩溃/退出自动重建，任务报错但不拖垮主进程

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('../workers/map-worker.js', import.meta.url);
const IDLE_MS = 60000;
// 每个任务让 worker 的 RSS 涨约 8MB；跑 4 个就重建，把内存压回基线（实测 terminate 能归还）。
const MAX_TASKS = 4;

let worker = null;
let pending = null;       // { resolve, reject, timer, startedAt }
let idleTimer = null;
let taskCount = 0;
let busy = false;

/** 主进程内存水位检查（native 不在 V8 堆里，只能看 RSS）。 */
export function assertMemoryHeadroom(limitMb = 1500) {
  const rssMb = Math.round(process.memoryUsage().rss / 1048576);
  if (rssMb > limitMb) {
    throw new Error('主进程内存 ' + rssMb + 'MB 已超水位 ' + limitMb + 'MB，拒绝执行重操作（先释放或重启）');
  }
  return rssMb;
}

function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleKill() {
  clearIdle();
  idleTimer = setTimeout(() => {
    if (!busy && worker) {
      const w = worker;
      worker = null;
      w.terminate().catch(() => {});
    }
  }, IDLE_MS);
  idleTimer.unref?.();
}

function rejectPending(err) {
  const p = pending;
  pending = null;
  busy = false;
  if (p) {
    clearTimeout(p.timer);
    p.reject(err);
  }
}

function createWorker(memLimitMb) {
  const w = new Worker(fileURLToPath(WORKER_URL), {
    resourceLimits: {
      maxOldGenerationSizeMb: memLimitMb,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
    stdout: false,
    stderr: false,
  });

  // 不阻止主进程退出：测试/一次性脚本跑完后不必等 60 秒空闲回收
  w.unref?.();

  w.on('message', (msg) => {
    const p = pending;
    pending = null;
    busy = false;
    clearIdle();
    if (!p) return;
    clearTimeout(p.timer);
    if (msg && msg.ok) p.resolve(msg);
    else p.reject(new Error((msg && msg.error) || 'worker 执行失败'));
    // 任务完成后按需重建或进入空闲倒计时
    if (taskCount >= MAX_TASKS) {
      const old = worker;
      worker = null;
      taskCount = 0;
      // 先摘监听器再 terminate：否则旧 worker 的 exit 会误判成「当前 worker 退出」，
      // 把下一个任务直接 reject（实测踩到过）
      old.removeAllListeners();
      old.terminate().catch(() => {});
    } else {
      scheduleIdleKill();
    }
  });

  w.on('error', (e) => {
    const old = worker;
    worker = null;
    rejectPending(new Error('worker 崩溃：' + (e && e.message ? e.message : e)));
    old.terminate().catch(() => {});
  });

  w.on('exit', (code) => {
    if (worker !== w) return; // 已被重建替换的旧 worker，忽略
    worker = null;
    if (pending) rejectPending(new Error('worker 提前退出，退出码 ' + code));
  });

  return w;
}

/**
 * 跑一个重任务（worker 内执行，常驻复用）。
 * @param {object} job { type: 'raster' | 'psd', ... }
 * @param {object} opts { timeoutMs, memLimitMb }
 * @returns {Promise<{buffer:Buffer,width:number,height:number}>}
 */
export function runHeavy(job, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const memLimitMb = opts.memLimitMb ?? 256;

  if (busy || pending) return Promise.reject(new Error('已有重操作在跑（单并发锁），请等它结束'));

  busy = true;
  clearIdle();
  if (!worker) { worker = createWorker(memLimitMb); taskCount = 0; }
  taskCount += 1;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const old = worker;
      worker = null;
      rejectPending(new Error('重操作超时（' + timeoutMs + 'ms）已强制终止'));
      old && old.terminate().catch(() => {});
    }, timeoutMs);

    pending = { resolve, reject, timer };
    try {
      worker.postMessage(job);
    } catch (e) {
      rejectPending(e);
    }
  });
}

/** 主动关掉常驻 worker（测试/退出时用），释放 native 内存。 */
export function shutdownHeavy() {
  clearIdle();
  const w = worker;
  worker = null;
  taskCount = 0;
  if (w) w.terminate().catch(() => {});
}

/** 当前是否有重任务在跑（给上层做提示用）。 */
export function isHeavyBusy() {
  return busy;
}
