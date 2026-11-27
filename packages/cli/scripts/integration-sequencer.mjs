import fs from 'node:fs';
import path from 'node:path';

import { BaseSequencer } from 'vitest/node';

const durations = JSON.parse(fs.readFileSync(new URL('./integration-durations.json', import.meta.url), 'utf8'));

// Use the discovered files as the source of coverage. Timing data only controls
// placement, so new and renamed tests cannot disappear from CI.
export function partitionByDuration(files, count, root, seconds) {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const fallback = known[Math.floor(known.length / 2)] ?? 1;
  const entries = files.map((spec) => {
    const name = path.relative(root, spec.moduleId).replaceAll('\\', '/');
    return { spec, name, seconds: seconds[name] ?? fallback };
  }).sort((a, b) => b.seconds - a.seconds || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const entry of entries) {
    const target = shards.reduce((best, shard) => shard.seconds < best.seconds ? shard : best);
    target.files.push(entry.spec);
    target.seconds += entry.seconds;
  }
  return shards.map((shard) => shard.files);
}

export default class IntegrationSequencer extends BaseSequencer {
  async shard(files) {
    const platform = process.env.AW_TEST_SHARD_PLATFORM || process.platform;
    const seconds = durations.seconds[platform];
    if (!seconds) throw new Error(`No integration timing profile for ${platform}. Use win32, darwin or linux.`);
    if (files.some((spec) => spec.project.name !== 'integration')) {
      throw new Error('The duration sequencer requires --project integration.');
    }
    const { count, index } = this.ctx.config.shard;
    return partitionByDuration(files, count, this.ctx.config.root, seconds)[index - 1];
  }
}
