import { describe, expect, it } from 'vitest';

import type { PluginManifestSource } from '../../src/types.js';
import {
  orderPluginsByDependencies,
  resolvePluginDependencyClosure,
  validatePluginDependencyGraph,
} from '../../src/utils/plugin-dependencies.js';

function plugin(
  name: string,
  dependencies: string[] = [],
  products?: string[],
): PluginManifestSource {
  return {
    name,
    version: '1.0.0',
    description: name,
    dependencies,
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products,
      },
    },
  };
}

describe('plugin dependency graph', () => {
  it('returns a stable dependency-first order and a root-scoped closure', () => {
    const plugins = [
      plugin('unrelated'),
      plugin('root', ['beta', 'alpha']),
      plugin('beta', ['leaf']),
      plugin('alpha', ['leaf']),
      plugin('leaf'),
    ];

    expect(orderPluginsByDependencies(plugins).map((entry) => entry.name)).toEqual([
      'leaf',
      'unrelated',
      'alpha',
      'beta',
      'root',
    ]);
    expect(resolvePluginDependencyClosure(plugins, ['root']).map((entry) => entry.name)).toEqual([
      'leaf',
      'alpha',
      'beta',
      'root',
    ]);
  });

  it('rejects missing dependencies, cycles, and incomplete marketplace product coverage', () => {
    expect(() => validatePluginDependencyGraph([
      plugin('parent', ['missing']),
    ])).toThrow('requires missing plugin "missing" from the same source');

    expect(() => validatePluginDependencyGraph([
      plugin('alpha', ['beta']),
      plugin('beta', ['alpha']),
    ])).toThrow('cycle alpha -> beta -> alpha');

    expect(() => validatePluginDependencyGraph([
      plugin('parent', ['codex-only']),
      plugin('codex-only', [], ['CODEX']),
    ])).toThrow('CLAUDE'.toLowerCase());

    expect(() => validatePluginDependencyGraph([
      plugin('codex-parent', ['both'], ['CODEX']),
      plugin('both'),
    ])).not.toThrow();
  });

  it('rejects dependency depth and closure limits', () => {
    const deep = Array.from({ length: 34 }, (_, index) =>
      plugin(`node-${index}`, index === 33 ? [] : [`node-${index + 1}`]));
    expect(() => validatePluginDependencyGraph(deep)).toThrow('dependency depth');

    const wide = [plugin('root', Array.from({ length: 64 }, (_, index) => `branch-${index}`))];
    for (let branch = 0; branch < 64; branch += 1) {
      const leaves = Array.from({ length: 4 }, (_, index) => `leaf-${branch}-${index}`);
      wide.push(plugin(`branch-${branch}`, leaves));
      wide.push(...leaves.map((name) => plugin(name)));
    }
    expect(() => validatePluginDependencyGraph(wide)).toThrow('dependency closure');
  });
});
