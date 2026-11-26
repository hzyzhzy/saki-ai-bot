import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import java.io.*;
import javax.tools.ToolProvider;

// java Build.java [只读的 .minecraft/libraries 路径]；所有产物写到当前工程的 build/。
class Build {
 public static void main(String[] args) throws Exception {
  Path libs=Path.of(args.length==0?"C:/minecraftje/.minecraft/libraries":args[0]);
  List<String> jars;
  try(var walk=Files.walk(libs)){jars=new ArrayList<>(walk.filter(p->p.toString().endsWith(".jar")).map(Path::toString).sorted().toList());}
  String srg=libs.resolve("net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-srg.jar").toString();
  if(!jars.remove(srg))throw new IOException("缺少目标版本 SRG 客户端库"); jars.add(0,srg);
  String cp=String.join(File.pathSeparator,jars); Path cls=Path.of("build/classes"); Files.createDirectories(cls);
  var compiler=ToolProvider.getSystemJavaCompiler(); if(compiler==null)throw new IOException("需要 JDK 17 或更高版本");
  int code=compiler.run(null,null,null,"--release","17","-proc:none","-cp",cp,"-d",cls.toString(),"src/saki/Protocol.java","src/saki/Bridge.java"); if(code!=0)System.exit(code);
  Path tests=Path.of("build/tests");Files.createDirectories(tests);
  if(compiler.run(null,null,null,"--release","17","-proc:none","-cp",cls+File.pathSeparator+cp,"-d",tests.toString(),"test/saki/Checks.java")!=0)System.exit(1);
  try(var loader=new java.net.URLClassLoader(java.util.stream.Stream.concat(java.util.stream.Stream.of(tests.toString(),cls.toString()),jars.stream()).map(s->{try{return Path.of(s).toUri().toURL();}catch(Exception e){throw new RuntimeException(e);}}).toArray(java.net.URL[]::new))){loader.loadClass("saki.Checks").getMethod("main",String[].class).invoke(null,(Object)new String[0]);}
  Path dest=Path.of("build/saki-client-1.20.1.jar");try(var out=new JarOutputStream(Files.newOutputStream(dest));var files=Files.walk(cls)){for(Path p:files.filter(Files::isRegularFile).toList()){out.putNextEntry(new JarEntry(cls.relativize(p).toString().replace('\\','/')));Files.copy(p,out);out.closeEntry();}out.putNextEntry(new JarEntry("META-INF/mods.toml"));Files.copy(Path.of("mods.toml"),out);out.closeEntry();out.putNextEntry(new JarEntry("META-INF/accesstransformer.cfg"));Files.copy(Path.of("accesstransformer.cfg"),out);out.closeEntry();out.putNextEntry(new JarEntry("pack.mcmeta"));Files.copy(Path.of("pack.mcmeta"),out);out.closeEntry();}System.out.println(dest);
 }
}
