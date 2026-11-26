// 真 headless + 本机假接口：直接断言发到 HTTP 服务的模型名，不连 QQ 或外部模型。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { taskModelLaunchArgs } from '../src/task-model-launch.js';
const base=mkdtempSync(join(tmpdir(),'qq-model-wire-')); const seen=[];
const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;
 const j=JSON.parse(body);seen.push(j.model); const chunk=(delta,finish_reason)=>JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:j.model,choices:[{index:0,delta,finish_reason}]});
 res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${chunk({role:'assistant',content:'验证成功'},null)}\n\ndata: ${chunk({},'stop')}\n\ndata: [DONE]\n\n`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let launch;
try{const model='wire-model';const provider='qq-wire-test';const home=process.env.DSH_HOME||join(process.env.LOCALAPPDATA,'DeepSeekHarness','.dsh');
 writeFileSync(join(base,'settings.yaml'),yaml.dump({'agent-default-model':{provider:'unused',model:'wrong'},'llm-pi-ai':{providers:{[provider]:{api:'openai-completions',baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:'QQ_MODEL_TEST_KEY',models:[{id:model,name:model,contextWindow:128000,maxTokens:2048}]}}}}));
 const dsh=join(process.env.LOCALAPPDATA,'Programs','DeepSeekHarness','dsh','node_modules','@deepseek-ai','dsh','lib','bin.js');
 launch=taskModelLaunchArgs({dsh,profile:'headless',prompt:'只回答验证成功',home:base,route:{provider,model}});
 const p=spawn(process.execPath,launch.args,{cwd:base,windowsHide:true,env:{...process.env,DSH_HOME:home,QQ_MODEL_TEST_KEY:'local-test',DSH_PERMISSION_MODE:'read-only'},stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',d=>{err+=String(d)});const timer=setTimeout(()=>p.kill(),45000);let code;try{code=await new Promise((r,j)=>{p.once('error',j);p.once('close',r)});}finally{clearTimeout(timer)}
 assert.equal(code,0,err.slice(-1200));assert.ok(seen.includes(model));console.log('真实 headless 请求已命中本机指定 provider，HTTP 请求 model='+model);
}finally{launch?.cleanup?.();server.close();rmSync(base,{recursive:true,force:true});}
