import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { config } from '../src/config.js';
import { resolveTaskModel } from '../src/task-model.js';
import { taskModelLaunchArgs } from '../src/task-model-launch.js';
import { buildTools, normalizeCall } from '../src/tools-fc.js';

const old = config.agent.models;
try {
  config.agent.models = [{name:'本地 4B', aliases:['4b'], provider:'local4b',model:'qwen3.5-4b'},
    {name:'GPT-6 Luna', aliases:['gpt6'], provider:'chihaya2',model:'gpt-6-luna'}];
  assert.equal(resolveTaskModel(), null);
  assert.equal(resolveTaskModel(' 4B ').model, 'qwen3.5-4b');
  assert.equal(resolveTaskModel('chihaya2/gpt-6-luna').name, 'GPT-6 Luna');
  assert.throws(() => resolveTaskModel('GPT6.2'), /不在可选/);
  assert.throws(() => resolveTaskModel('x; echo injected'), /不在可选/);
  const full = buildTools({});
  assert.deepEqual(buildTools({lite:true}), full);
  assert.deepEqual(buildTools({workChat:true}), []);
  const tool = full.find(t => t.function.name === 'take_task').function;
  assert.ok(tool.parameters.properties.model);
  assert.ok(!tool.parameters.required.includes('model'));
  assert.ok(tool.description.includes('GPT-6 Luna'));
  const normalized = normalizeCall({name:'take_task',arguments:JSON.stringify({task:'制作动画',model:'本地 4B'})});
  assert.equal(normalized.args.用什么模型, '本地 4B');
  const home = mkdtempSync(join(tmpdir(),'qqbot-route-test-'));
  mkdirSync(home, {recursive:true});
  const original = {'agent-default-model':{provider:'original',model:'default',reasoningEffort:'high'},
    'llm-pi-ai':{providers:{local4b:{baseURL:'http://127.0.0.1:1/v1',apiKeyEnv:'LOCAL_API_KEY'}}}};
  const originalText = yaml.dump(original);
  writeFileSync(join(home,'settings.yaml'),originalText);
  const prompt = '做动画; 这只是单独的任务参数';
  assert.deepEqual(taskModelLaunchArgs({dsh:'bin.js',profile:'headless',home,prompt}).args,
    ['bin.js','--profile','headless',prompt]);
  const launch = taskModelLaunchArgs({dsh:'bin.js',profile:'headless',home,prompt,route:resolveTaskModel('4b')});
  assert.equal(launch.args.at(-1),prompt);
  const patch = yaml.load(readFileSync(launch.args[4],'utf8'));
  assert.equal(patch[0].id,'settings');
  assert.equal(patch[0].config.watch,false);
  const copy = yaml.load(readFileSync(patch[0].config.path,'utf8'));
  assert.equal(copy['agent-default-model'].provider,'local4b');
  assert.equal(copy['agent-default-model'].model,'qwen3.5-4b');
  assert.equal(copy['agent-default-model'].reasoningEffort,'high');
  assert.deepEqual(copy['llm-pi-ai'],original['llm-pi-ai']);
  assert.equal(readFileSync(join(home,'settings.yaml'),'utf8'),originalText);
  console.log('通过：默认不变、精确选型、未知拒绝、工具参数、全量/lite一致、单次设置隔离、思考设置保留、全局配置未变');
} finally { config.agent.models = old; }
