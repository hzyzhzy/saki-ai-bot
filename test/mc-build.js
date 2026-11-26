import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {planBuild,mcAction} from '../src/mc-build.js';
import {buildTools,normalizeCall} from '../src/tools-fc.js';
const plot={min:[10,64,-12],max:[30,80,8]},part={from:[0,0,0],to:[2,1,2],block:'oak_planks'};
assert.equal(planBuild([part,part],plot).length,18);assert.deepEqual(planBuild([part],plot)[0],{x:10,y:64,z:-12,block:'minecraft:oak_planks'});
for(const p of [{...part,to:[24,0,0]},{...part,from:[-1,0,0]},{...part,to:[20,2,20]},{...part,block:'tnt'}])assert.throws(()=>planBuild([p],plot));assert.throws(()=>planBuild([part],null));
assert.deepEqual(buildTools({}),buildTools({lite:true}));assert.deepEqual(buildTools({workChat:true}),[]);
const norm=normalizeCall({name:'mc_action',arguments:JSON.stringify({action:'build',parts:[part]})});assert.equal(norm.args.动作,'build');
const dir=mkdtempSync(join(tmpdir(),'saki-build-test-')),ctx={dir,host:'mc.example.com',plot,gid:'g1'};
const timer=setInterval(()=>{const p=join(dir,'inbox.json');if(!existsSync(p))return;renameSync(p,join(dir,'claimed.json'));const r=JSON.parse(readFileSync(join(dir,'claimed.json')));assert.equal(r.server,ctx.host);writeFileSync(join(dir,'response.tmp'),JSON.stringify({id:r.id,status:r.action==='build'?'running':'stopped',message:'测试回执'}));renameSync(join(dir,'response.tmp'),join(dir,'outbox.json'));},20);
try{assert.match(await mcAction(norm.args,ctx),/running/);assert.match(await mcAction(norm.args,ctx),/没有覆盖/);assert.match(await mcAction({动作:'stop'},{...ctx,gid:'other'}),/不能覆盖/);assert.match(await mcAction({动作:'stop'},ctx),/stopped/);console.log('通过：建筑坐标、材料、数量、工具参数、目标服绑定、回执、互斥和停止。');}finally{clearInterval(timer);rmSync(dir,{recursive:true,force:true});}
