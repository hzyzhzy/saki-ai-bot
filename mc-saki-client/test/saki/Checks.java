package saki;
import com.google.gson.*;
public class Checks {
 static final String BASE="{\"id\":\"a\",\"action\":\"build\",\"server\":\"hzymtr.space:25565\",\"expiresAt\":10001,\"blocks\":[{\"x\":1,\"y\":2,\"z\":3,\"block\":\"minecraft:glass\"},{\"x\":1,\"y\":1,\"z\":3,\"block\":\"minecraft:oak_log\"}]}";
 static Protocol.Request read(String s,long now){return Protocol.parse(JsonParser.parseString(s).getAsJsonObject(),now);}
 static int n;static void check(boolean b){if(!b)throw new AssertionError();n++;}
 static void bad(String s,long now){try{read(s,now);throw new AssertionError(s);}catch(RuntimeException ok){n++;}}
 public static void main(String[] args){check(read(BASE,1).blocks().get(0).y()==1);check(Protocol.host("HZYMTR.SPACE"));for(String h:new String[]{"hzymtr.space:25566","hzymtr.space.evil","hzymtr.space@x","127.0.0.1"})bad(BASE.replace("hzymtr.space:25565",h),1);bad(BASE,10001);bad(BASE,0);bad(BASE.replace("expiresAt","expires"),1);bad(BASE.replace("minecraft:glass","minecraft:tnt"),1);bad(BASE.replace("\"y\":2","\"y\":1"),1);bad(BASE.replace("\"y\":2","\"y\":1.5"),1);bad(BASE.replace("\"y\":2","\"y\":320"),1);bad(BASE.replace("build","command"),1);for(String a:new String[]{"status","stop"})check(read(BASE.replace("build",a),1).blocks().isEmpty());var many=JsonParser.parseString(BASE).getAsJsonObject();while(many.getAsJsonArray("blocks").size()<257)many.getAsJsonArray("blocks").add(many.getAsJsonArray("blocks").get(0));bad(many.toString(),1);System.out.println("协议测试通过："+n+" 项");}
}
