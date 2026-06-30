/**
 * cpuMonitor.js — Background CPU, memory, and FFmpeg process sampler
 *
 * Usage:
 *   import { startCpuMonitor, stopCpuMonitor } from './cpuMonitor.js';
 *
 *   const monitor = startCpuMonitor(workflowId, sampleIntervalMs);
 *   // ... do work ...
 *   const summary = stopCpuMonitor(monitor);
 */

import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('CpuMonitor');

/**
 * Start a background CPU/memory/process sampler.
 *
 * @param {string} workflowId  — for log labeling
 * @param {number} intervalMs  — sample frequency in ms (default 2000)
 * @returns {object} monitor handle — pass to stopCpuMonitor()
 */
export function startCpuMonitor(workflowId, intervalMs = 2000) {
  const samples = [];
  const startTime = Date.now();

  // CPU usage baseline (os.cpus() returns cumulative ticks, need two reads to compute %)
  let prevCpuInfo = os.cpus();

  const intervalId = setInterval(() => {
    try {
      // ── CPU usage (average across all cores) ──────────────────────────
      const currCpuInfo = os.cpus();
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

      const cpuPct = totalTick > 0
        ? (100 - (100 * totalIdle / totalTick)).toFixed(1)
        : '0.0';
      prevCpuInfo = currCpuInfo;

      // ── Memory ────────────────────────────────────────────────────────
      const freeMem = os.freemem();
      const totalMem = os.totalmem();
      const usedMemMB = ((totalMem - freeMem) / 1024 / 1024).toFixed(0);
      const memPct = ((1 - freeMem / totalMem) * 100).toFixed(1);

      // ── Load average (Unix only) ───────────────────────────────────────
      const [load1, load5, load15] = os.loadavg();

      // ── Count FFmpeg processes ────────────────────────────────────────
      let ffmpegCount = 0;
      try {
        const psOut = execSync("ps aux 2>/dev/null | grep -c '[f]fmpeg'", {
          timeout: 500,
          encoding: 'utf8',
        }).trim();
        ffmpegCount = parseInt(psOut, 10) || 0;
      } catch (_) {
        // ps may fail on Windows or under load — ignore
      }

      const sample = {
        t: Date.now() - startTime,
        wallTime: Date.now(),
        cpuPct: parseFloat(cpuPct),
        usedMemMB: parseInt(usedMemMB, 10),
        memPct: parseFloat(memPct),
        load1: parseFloat(load1.toFixed(2)),
        load5: parseFloat(load5.toFixed(2)),
        load15: parseFloat(load15.toFixed(2)),
        ffmpegCount,
      };

      samples.push(sample);

      // Log every sample so it's visible in PM2 logs
      logger.info(
        `📊 [CPU][${workflowId}] ` +
        `cpu=${cpuPct}% | mem=${usedMemMB}MB (${memPct}%) | ` +
        `load=${load1.toFixed(2)} | ffmpeg_procs=${ffmpegCount}`,
      );
    } catch (err) {
      // Never crash the workflow due to monitoring
      logger.error(`[CpuMonitor] Sampling error: ${err.message}`);
    }
  }, intervalMs);

  return { intervalId, samples, startTime, workflowId };
}

/**
 * Stop the monitor and return a summary.
 *
 * @param {object} monitor — handle from startCpuMonitor()
 * @returns {object} summary with peak/avg stats
 */
export function stopCpuMonitor(monitor) {
  if (!monitor) return null;
  clearInterval(monitor.intervalId);

  const { samples, workflowId } = monitor;
  if (samples.length === 0) return { samples: [] };

  const avgCpu = (samples.reduce((s, x) => s + x.cpuPct, 0) / samples.length).toFixed(1);
  const peakCpu = Math.max(...samples.map(x => x.cpuPct));
  const peakMem = Math.max(...samples.map(x => x.usedMemMB));
  const peakFfmpeg = Math.max(...samples.map(x => x.ffmpegCount));
  const avgFfmpeg = (samples.reduce((s, x) => s + x.ffmpegCount, 0) / samples.length).toFixed(1);

  const summary = {
    workflowId,
    sampleCount: samples.length,
    avgCpuPct: parseFloat(avgCpu),
    peakCpuPct: peakCpu,
    peakMemMB: peakMem,
    peakFfmpegProcesses: peakFfmpeg,
    avgFfmpegProcesses: parseFloat(avgFfmpeg),
    samples,
  };

  logger.info(
    `📊 [CPU SUMMARY][${workflowId}] ` +
    `avgCpu=${avgCpu}% | peakCpu=${peakCpu}% | ` +
    `peakMem=${peakMem}MB | peakFFmpeg=${peakFfmpeg}`,
  );

  return summary;
}
