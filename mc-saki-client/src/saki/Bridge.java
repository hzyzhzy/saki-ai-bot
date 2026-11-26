package saki;
import com.google.gson.*;
import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.event.TickEvent;
import net.minecraftforge.eventbus.api.SubscribeEvent;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.prediction.BlockStatePredictionHandler;
import net.minecraft.core.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.*;
import net.minecraft.world.level.*;
import net.minecraft.world.phys.*;
import java.nio.file.*;
import java.io.*;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.*;

@Mod("saki_bridge")
public class Bridge {
 @Mod.EventBusSubscriber(modid="saki_bridge",value=Dist.CLIENT)
 public static final class Client {
  static Path dir; static Protocol.Request job; static ClientLevel world; static Object player;
  static int tick,index,wait; static BlockPos pending; static Field handler,states;
  static final Map<String,Long> seen=new HashMap<>();
  static final Set<String> GROUND=Set.of("minecraft:dirt","minecraft:grass_block","minecraft:stone","minecraft:deepslate","minecraft:andesite","minecraft:diorite","minecraft:granite","minecraft:bedrock");
  static void check(boolean ok,String msg){Protocol.require(ok,msg);}
  static boolean online(Minecraft m){var s=m.m_91089_();return s!=null&&Protocol.host(s.f_105363_)&&m.m_91092_()==null&&m.m_91403_()!=null&&m.m_91403_().m_104910_().m_129536_()&&m.f_91074_!=null&&m.f_91073_!=null&&m.f_91072_!=null&&m.f_91074_.m_36316_().getName().equals("Saki");}
  static void buildGuard(Minecraft m){check(online(m)&&m.f_91073_==world&&m.f_91074_==player,"在线会话或玩家改变");check(m.f_91073_.m_46472_()==Level.f_46428_,"仅限主世界");check(m.f_91072_.m_105295_()==GameType.SURVIVAL&&m.f_91074_.m_6084_()&&m.f_91080_==null,"需要存活的生存玩家且未打开界面");}
  static void reply(Minecraft m,String id,String status,String msg)throws IOException{var o=new JsonObject();o.addProperty("id",id);o.addProperty("status",status);o.addProperty("message",msg);if(online(m)){var p=m.f_91074_.m_20183_();var xyz=new JsonObject();xyz.addProperty("x",p.m_123341_());xyz.addProperty("y",p.m_123342_());xyz.addProperty("z",p.m_123343_());o.add("position",xyz);o.addProperty("player","Saki");o.addProperty("dimension",m.f_91073_.m_46472_().m_135782_().toString());}Path tmp=dir.resolve("outbox.tmp");Files.writeString(tmp,o.toString());Files.move(tmp,dir.resolve("outbox.json"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}
  static void clear(){job=null;world=null;player=null;pending=null;index=0;wait=0;}
  static void poll(Minecraft m)throws IOException{
   Path in=dir.resolve("inbox.json"),claimed=dir.resolve("claimed.json");try{Files.move(in,claimed,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);}catch(NoSuchFileException absent){return;}
   String id="invalid";try{byte[] bytes;try(var stream=Files.newInputStream(claimed)){bytes=stream.readNBytes(65537);}check(bytes.length<=65536,"请求太大");var o=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8)).getAsJsonObject();id=Protocol.text(o,"id");check(id.matches("[a-zA-Z0-9_.:-]{1,128}"),"无效编号");long now=System.currentTimeMillis();seen.values().removeIf(exp->exp<=now);if(seen.containsKey(id))return;var r=Protocol.parse(o,now);seen.put(id,now+11000);check(online(m),"未连接指定服务器或玩家不是 Saki");
    switch(r.action()){case "stop"->{String msg=job==null?"没有进行中的建造":"停止 "+job.id()+"，已确认 "+index+" 块；已发送的一次交互无法撤回";clear();reply(m,id,"stopped",msg);}case "status"->reply(m,id,"done",job==null?"空闲":"建造中："+job.id()+"，已确认 "+index+" 块");case "build"->{check(job==null,"已有建造任务");world=m.f_91073_;player=m.f_91074_;buildGuard(m);initPrediction(m);reply(m,id,"running","开始建造");job=r;}}
   }catch(RuntimeException|ReflectiveOperationException e){reply(m,id.length()>128?"invalid":id,"error",Objects.toString(e.getMessage(),"请求无效"));}
  }
  // 本版本客户端会先本地预测；直到原版服务端 ACK 将该坐标从预测表移除才核对结果。
  static void initPrediction(Minecraft m)throws ReflectiveOperationException{if(handler==null||states==null){handler=ClientLevel.class.getDeclaredField("f_233599_");states=BlockStatePredictionHandler.class.getDeclaredField("f_233851_");/* Forge 在加载类时根据 META-INF/accesstransformer.cfg 公开这两个字段。 */}prediction(m);}
  static Map<?,?> prediction(Minecraft m)throws ReflectiveOperationException{return (Map<?,?>)states.get(handler.get(m.f_91073_));}
  static String block(Minecraft m,BlockPos p){return BuiltInRegistries.f_256975_.m_7981_(m.f_91073_.m_8055_(p).m_60734_()).toString();}
  static void step(Minecraft m)throws Exception{
   buildGuard(m);var cell=job.blocks().get(index);BlockPos target=new BlockPos(cell.x(),cell.y(),cell.z());
   if(pending!=null){check(++wait<=100,"等待服务器确认超时");if(prediction(m).containsKey(pending.m_121878_()))return;check(block(m,pending).equals(cell.block()),"服务器未确认放置");pending=null;index++;String id=job.id();if(index==job.blocks().size()){reply(m,id,"done","已确认 "+index+" 块");clear();}else reply(m,id,"running","已确认 "+index+" / "+job.blocks().size());return;}
   if(tick%5!=0)return;var level=m.f_91073_;var p=m.f_91074_;check(level.m_7232_(cell.x()>>4,cell.z()>>4)&&level.m_6857_().m_61937_(target)&&!level.m_151570_(target),"目标未加载或越界");check(level.m_46859_(target),"目标不是空气："+cell.x()+","+cell.y()+","+cell.z());
   var inv=p.m_150109_();int slot=-1;for(int i=0;i<9;i++){var item=inv.m_8020_(i);if(!item.m_41619_()&&!item.m_41782_()&&BuiltInRegistries.f_257033_.m_7981_(item.m_41720_()).toString().equals(cell.block())){slot=i;break;}}check(slot>=0,"快捷栏缺少无附加数据的材料："+cell.block());
   var eye=p.m_146892_();double reach=Math.min(4.5,m.f_91072_.m_105286_());BlockHitResult hit=null;
   for(Direction face:Direction.values()){var support=target.m_121945_(face.m_122424_());if(!level.m_7232_(support.m_123341_()>>4,support.m_123343_()>>4)||!level.m_6857_().m_61937_(support))continue;String base=block(m,support);if(!GROUND.contains(base)&&!Protocol.MATERIALS.contains(base))continue;
    var end=new Vec3(support.m_123341_()+.5+.499*face.m_122429_(),support.m_123342_()+.5+.499*face.m_122430_(),support.m_123343_()+.5+.499*face.m_122431_());if(!eye.m_82509_(end,reach))continue;var h=level.m_45547_(new ClipContext(eye,end,ClipContext.Block.OUTLINE,ClipContext.Fluid.NONE,p));if(h.m_6662_()==HitResult.Type.BLOCK&&h.m_82425_().equals(support)&&h.m_82434_()==face){hit=h;break;}}
   check(hit!=null,"没有触及范围内可见的普通支撑面");check(!prediction(m).containsKey(target.m_121878_()),"该坐标另有未确认交互");inv.f_35977_=slot;var result=m.f_91072_.m_233732_(p,InteractionHand.MAIN_HAND,hit);check(result.m_19077_(),"普通玩家放置未被接受");check(prediction(m).containsKey(target.m_121878_()),"未观察到原版放置预测，无法确认结果，不会重试");pending=target;wait=0;
  }
  @SubscribeEvent public static void tick(TickEvent.ClientTickEvent e){if(e.phase!=TickEvent.Phase.END)return;Minecraft m=Minecraft.m_91087_();tick++;try{if(dir==null){dir=m.f_91069_.toPath().resolve("saki-bridge");Files.createDirectories(dir);Path old=dir.resolve("outbox.json");if(Files.isRegularFile(old)&&Files.size(old)<65536){var last=JsonParser.parseString(Files.readString(old)).getAsJsonObject();if("running".equals(Protocol.text(last,"status")))reply(m,Protocol.text(last,"id"),"error","客户端重启，原任务不会续建");}}if(tick%5==0&&Files.isRegularFile(dir.resolve("inbox.json")))poll(m);if(job!=null)step(m);}catch(Exception ex){if(job!=null){String id=job.id();int n=index;clear();try{reply(m,id,"error","已确认 "+n+" 块；"+ex.getMessage());}catch(IOException ignored){}}else if(tick%100==0)System.getLogger("saki_bridge").log(System.Logger.Level.WARNING,ex.toString());}}
 }
}
