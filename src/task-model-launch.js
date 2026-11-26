import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

// 指定模型的任务使用独立设置快照，避免用户级 settings 覆盖启动补丁。
// 不复制凭据，不改变 DSH_HOME，不向任务产物目录写入内部配置。
export function taskModelLaunchArgs({ dsh, profile, prompt, home, route }) {
  const args = [dsh, '--profile', profile];
  if (!route) return { args: [...args, prompt], snapshotDir: '' };
  if (!route.provider || !route.model) throw new Error('指定模型缺少 provider/model');
  const settings = yaml.load(readFileSync(join(home, 'settings.yaml'), 'utf8')) ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('DSH settings.yaml 格式不正确');
  settings['agent-default-model'] = {
    ...(settings['agent-default-model'] ?? {}),
    provider: route.provider,
    model: route.model,
  };
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-task-model-'));
  const settingsPath = join(dir, 'settings.yaml');
  const patchPath = join(dir, 'model.patch.yml');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    writeFileSync(settingsPath, yaml.dump(settings), { encoding: 'utf8', mode: 0o600 });
    writeFileSync(patchPath, yaml.dump([{ id: 'settings', name: '@deepseek-ai/dsh-settings-file', config: { path: settingsPath, watch: false } }]),
      { encoding: 'utf8', mode: 0o600 });
    return { args: [...args, '--patch', patchPath, prompt], snapshotDir: dir, cleanup };
  } catch (e) { cleanup(); throw e; }
}
