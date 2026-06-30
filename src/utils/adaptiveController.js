import os from 'os';
import { createLogger } from './logger.js';
import { segmentSemaphore } from './renderQueue.js';

const logger = createLogger('AdaptiveController');

let controllerInterval = null;
let prevCpuInfo = null;

/**
 * Calculates the average CPU load percentage across all cores since the last call.
 */
function getCpuUsagePct() {
  const currCpuInfo = os.cpus();
  if (!prevCpuInfo) {
    prevCpuInfo = currCpuInfo;
    return 0;
  }

  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < currCpuInfo.length; i++) {
    const prev = prevCpuInfo[i];
    const curr = currCpuInfo[i];

    const prevTotal = Object.values(prev.times).reduce((a, b) => a + b, 0);
    const currTotal = Object.values(curr.times).reduce((a, b) => a + b, 0);
    const prevIdle = prev.times.idle;
    const currIdle = curr.times.idle;

    totalIdle += currIdle - prevIdle;
    totalTick += currTotal - prevTotal;
  }

  prevCpuInfo = currCpuInfo;

  return totalTick > 0 ? (100 - (100 * totalIdle / totalTick)) : 0;
}

/**
 * Starts the adaptive concurrency controller loop.
 * Runs every 5 seconds.
 */
export function startAdaptiveController() {
  if (controllerInterval) return; // Already running

  const logicalCpus = os.cpus().length;
  const maxAllowedConcurrency = Math.max(2, logicalCpus - 1);
  const minAllowedConcurrency = 2;

  logger.info(`Starting Adaptive Concurrency Controller (Bounds: ${minAllowedConcurrency} to ${maxAllowedConcurrency})`);

  // Initialize CPU state
  getCpuUsagePct();

  controllerInterval = setInterval(() => {
    const cpuPct = getCpuUsagePct();
    const currentMax = segmentSemaphore.max;
    let newMax = currentMax;

    if (cpuPct < 70) {
      newMax = Math.min(maxAllowedConcurrency, currentMax + 1);
    } else if (cpuPct > 95) {
      newMax = Math.max(minAllowedConcurrency, currentMax - 1);
    }

    if (newMax !== currentMax) {
      logger.info(`⚖️ [AdaptiveController] CPU Load: ${cpuPct.toFixed(1)}%. Scaling Segment Concurrency: ${currentMax} -> ${newMax}`);
      segmentSemaphore.setMax(newMax);
    }

  }, 5000);
}

/**
 * Stops the adaptive concurrency controller loop.
 */
export function stopAdaptiveController() {
  if (controllerInterval) {
    clearInterval(controllerInterval);
    controllerInterval = null;
    logger.info('Adaptive Concurrency Controller stopped.');
  }
}
