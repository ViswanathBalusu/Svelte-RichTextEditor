/**
 * Metrics of the service process itself (BE-058): the delay of its event loop and its memory.
 * The load harness reads them from `/metrics` to say whether a run kept the event loop within the
 * budget the harness sets. They describe the whole process, so they carry only the node label.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Metrics } from './metrics.ts';

export interface ProcessMetrics {
  /** Stops sampling. */
  stop(): void;
}

/** The sampling resolution of the event-loop histogram, in milliseconds. */
const RESOLUTION_MS = 10;

/**
 * Registers `docedit_event_loop_delay_seconds` (quantiles 0.5, 0.99 and the maximum), the CPU time
 * and the memory of the process. The delay is that since the previous scrape: a scrape reads the
 * histogram and starts it again, so that a reading describes one interval, not the whole life of
 * the process. One scraper is assumed, as with any metric that is reset on reading.
 */
export function registerProcessMetrics(metrics: Metrics): ProcessMetrics {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  // The histogram reports nanoseconds, and includes the sampling interval itself; the reading is
  // the delay beyond it, which is what the loop lost to other work.
  const seconds = (ns: number): number => Math.max(0, ns / 1e9 - RESOLUTION_MS / 1000);
  metrics.gauge(
    'docedit_event_loop_delay_seconds',
    'Delay of the event loop beyond its sampling interval, since the previous scrape (BE-058).',
    async () => {
      const samples = [
        { labels: { quantile: '0.5' }, value: seconds(histogram.percentile(50)) },
        { labels: { quantile: '0.99' }, value: seconds(histogram.percentile(99)) },
        { labels: { quantile: '1' }, value: seconds(histogram.max) },
      ];
      histogram.reset();
      return samples;
    },
  );
  metrics.gauge(
    'docedit_process_cpu_seconds',
    'CPU time of the service process in seconds, user and system, since it started (BE-058).',
    async () => {
      const c = process.cpuUsage();
      return [
        { labels: { mode: 'user' }, value: c.user / 1e6 },
        { labels: { mode: 'system' }, value: c.system / 1e6 },
      ];
    },
  );
  metrics.gauge(
    'docedit_process_memory_bytes',
    'Memory of the service process (BE-058).',
    async () => {
      const m = process.memoryUsage();
      return [
        { labels: { kind: 'rss' }, value: m.rss },
        { labels: { kind: 'heap_used' }, value: m.heapUsed },
      ];
    },
  );
  return { stop: () => void histogram.disable() };
}
