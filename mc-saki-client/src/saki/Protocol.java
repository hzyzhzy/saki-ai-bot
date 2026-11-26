package saki;
import com.google.gson.*;
import java.util.*;

final class Protocol {
 static final Set<String> MATERIALS=Set.of("minecraft:oak_planks","minecraft:spruce_planks","minecraft:cobblestone","minecraft:stone_bricks","minecraft:glass","minecraft:bricks","minecraft:oak_log","minecraft:white_concrete");
 record Cell(int x,int y,int z,String block){}
 record Request(String id,String action,List<Cell> blocks){}
 static boolean host(String h){return "hzymtr.space".equalsIgnoreCase(h)||"hzymtr.space:25565".equalsIgnoreCase(h);}
 static void require(boolean ok,String msg){if(!ok)throw new IllegalArgumentException(msg);}
 static String text(JsonObject o,String k){var v=o.get(k);require(v!=null&&v.isJsonPrimitive()&&v.getAsJsonPrimitive().isString(),"缺少字符串："+k);return v.getAsString();}
 static long integer(JsonObject o,String k){var v=o.get(k);require(v!=null&&v.isJsonPrimitive()&&v.getAsJsonPrimitive().isNumber()&&v.toString().matches("-?[0-9]{1,16}"),"不是整数："+k);return v.getAsLong();}
 static Request parse(JsonObject o,long now){
  String id=text(o,"id"), action=text(o,"action");require(id.matches("[a-zA-Z0-9_.:-]{1,128}"),"无效任务编号");require(host(text(o,"server")),"服务器不匹配");long exp=integer(o,"expiresAt");require(exp>now&&exp-now<=10000,"请求已过期或截止时间不合规");require(Set.of("build","stop","status").contains(action),"不支持的动作");
  if(!action.equals("build"))return new Request(id,action,List.of());
  require(o.has("blocks")&&o.get("blocks").isJsonArray(),"缺少方块列表");var rows=o.getAsJsonArray("blocks");require(rows.size()>0&&rows.size()<=256,"每单限 1–256 块");var list=new ArrayList<Cell>();var unique=new HashSet<String>();
  for(var row:rows){var b=row.getAsJsonObject();int x=Math.toIntExact(integer(b,"x")),y=Math.toIntExact(integer(b,"y")),z=Math.toIntExact(integer(b,"z"));String material=text(b,"block");require(MATERIALS.contains(material),"材料不在白名单");require(Math.abs((long)x)<30000000&&Math.abs((long)z)<30000000&&y>=-64&&y<320,"坐标越界");require(unique.add(x+","+y+","+z),"重复坐标");list.add(new Cell(x,y,z,material));}
  list.sort(Comparator.comparingInt(Cell::y));return new Request(id,action,List.copyOf(list));
 }
}
