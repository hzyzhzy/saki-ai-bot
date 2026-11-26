import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

export const materials = ['oak_planks','spruce_planks','cobblestone','stone_bricks','glass','bricks','oak_log','white_concrete'];
const terminal = new Set(['done','error','stopped']);
const coord = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isSafeInteger);
export function planBuild(parts, plot) {
  if (!plot || !coord(plot.min) || !coord(plot.max) || !plot.min.every((v,i)=>v<=plot.max[i])) throw Error('还没有配置 Saki 的建筑地块，未动地图');
  if (!Array.isArray(parts) || !parts.length || parts.length>32) throw Error('建造计划须含 1 至 32 个长方体部件');
  const blocks = new Map();
  for (const {from,to,block} of parts) {
    if (!coord(from)||!coord(to)||!materials.includes(block)) throw Error('坐标或材料不符合建造范围');
    if (!from.every((v,i)=>v>=0 && v<=to[i] && to[i]<=24 && plot.min[i]+to[i]<=plot.max[i])) throw Error('部件越出地块或过大');
    for (let y=from[1];y<=to[1];y++) for(let x=from[0];x<=to[0];x++) for(let z=from[2];z<=to[2];z++) {
      blocks.set(`${x},${y},${z}`,{x:plot.min[0]+x,y:plot.min[1]+y,z:plot.min[2]+z,block:`minecraft:${block}`});
      if(blocks.size>256) throw Error('单次最多放置 256 块，请分段建造');
    }
  }
  return [...blocks.values()].sort((a,b)=>a.y-b.y||a.z-b.z||a.x-b.x);
}
const read = p => existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;
const working = new Map();
const receipt = r => `${r.status}；${String(r.message??'').slice(0,240)}`;
export async function mcAction(args,{host,dir,plot,gid}) {
  const action=args.动作;
  if (!['build','status','stop'].includes(action)||!host) throw Error('无效动作或服务器未配置');
  if (!existsSync(dir)) return '客户端桥未就绪，没有操作服务器。';
  if(working.has(dir)&&action!=='stop') return '客户端正在确认上一条操作，请稍后查进度。';
  const inbox=join(dir,'inbox.json'),outbox=join(dir,'outbox.json');
  // Forge 通过原子重命名领取请求；不能只看 inbox，否则刚领取的任务会被当成空闲。
  const prev=read(inbox) ?? read(join(dir,'claimed.json')), reply=read(outbox);
  const same=prev && reply?.id===prev.id;
  const busy=prev && (same ? !terminal.has(reply.status) : Date.now()<prev.expiresAt);
  if(busy && prev.group!==gid) return '另一个群的操作在执行，不能覆盖或停止。';
  if(busy && action==='status') return same?`上次客户端回执：${receipt(reply)}（非实时心跳）`:'已提交，客户端尚未确认。';
  if(!busy && action==='status' && same && prev.action==='build' && prev.group===gid) return `上次建造回执：${receipt(reply)}`;
  if(busy && action==='build') return '上一条操作尚未结束，没有覆盖。';
  if(action==='stop'&&!busy) return '没有正在执行的建造任务。';
  const blocks=action==='build'?planBuild(args.部件,plot):[];
  const id=randomUUID(), request={id,group:gid,server:host,action,blocks,expiresAt:Date.now()+10000};
  working.set(dir,id);
  try {
    const tmp=join(dir,`${id}.tmp`);writeFileSync(tmp,JSON.stringify(request),{flag:'wx'});renameSync(tmp,inbox);
    // 只在提交后的短窗口等确认，逐步退避；空闲时不读文件。
    for(const delay of [120,180,300,450,650,800,1000,1000]) {
      await wait(delay);
      const r=read(outbox);
      if(r?.id===id) return `客户端回执：${receipt(r)}。仅 done 表示本次操作结束。`;
    }
    return '已提交，但未收到客户端回执；不能说已经建好。未及时接收的请求会过期。';
  } finally {if(working.get(dir)===id) working.delete(dir);}
}
