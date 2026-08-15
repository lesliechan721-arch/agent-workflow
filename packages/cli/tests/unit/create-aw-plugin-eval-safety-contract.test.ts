import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

describe('create-aw-plugin real-model eval safety contract', () => {
  // Static contract exception: an author agent could start an unmanaged real-model eval without informed consent or safe process monitoring; behavior test is not suitable because these requirements govern agent instructions and have no deterministic runtime entry point.
  it('keeps the minimum consent and monitoring safeguards in the source Skill', async () => {
    const skill = await fs.readFile(
      path.join(repoRoot, '.agents', 'skills', 'create-aw-plugin', 'SKILL.md'),
      'utf8',
    );

    expect(skill).toContain(
      '用户是否已明确选择整个会话使用 Full Access，或明确选择 `--allow-unmanaged-processes`',
    );
    expect(skill).toContain('用户未选择时必须停下询问');
    expect(skill).toContain('不得自行添加该参数');
    expect(skill).toContain('也不得请求单次提权');
    expect(skill).toContain('真实模型 eval 启动后保留同一进程会话');
    expect(skill).toContain('首轮和后续等待都使用工具允许的最长响应式等待时间');
    expect(skill).toContain('等待超时不表示 eval 失败');
    expect(skill).toContain('Git 或其它状态轮询命令');
    expect(skill).toContain('不得另开 shell `sleep`');
    expect(skill).toContain('`sleep`、`ps`');
    expect(skill).toContain('`ps`、报告文件');
    expect(skill).toContain('报告文件、Git');
    expect(skill).toContain('不得使用短 `wait` 循环');
  });
});
