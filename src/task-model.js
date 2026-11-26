// 群任务的模型选择只作用于本次执行，不修改聊天模型或全局默认。
import { config } from './config.js';

export function taskModelChoices() {
  return (Array.isArray(config.agent?.models) ? config.agent.models : [])
    .filter(x => x && typeof x.name === 'string' && typeof x.provider === 'string' && typeof x.model === 'string')
    .map(x => ({ name: x.name.trim(), provider: x.provider.trim(), model: x.model.trim(),
      aliases: Array.isArray(x.aliases) ? x.aliases.filter(a => typeof a === 'string') : [] }))
    .filter(x => x.name && x.provider && x.model);
}

export function resolveTaskModel(requested) {
  const raw = String(requested ?? '').trim();
  if (!raw) return null;
  const key = x => String(x).trim().toLowerCase().replace(/\s+/g, '');
  const matches = taskModelChoices().filter(x =>
    [x.name, x.model, `${x.provider}/${x.model}`, ...x.aliases].some(a => key(a) === key(raw)));
  if (matches.length !== 1) throw new Error(`模型「${raw}」${matches.length ? '对应多个选项，请明确型号' : '不在可选列表中'}；未启动任务，也未替换成默认模型`);
  return matches[0];
}
