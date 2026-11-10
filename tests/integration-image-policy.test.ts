import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { labCompose,LAB_IMAGES,LAB_SOURCE,upLab,checkLab,downLab } from "../src/integration-lab.js";
import { BridgeError } from "../src/types.js";
import { state,setup,fakeDocker,fakeHttp } from "./lab-harness.js";
import { legacyRun,legacyTemplate,signedRunEdit } from "./lab-legacy-harness.js";
const isCode=(code:string)=>(error:unknown)=>error instanceof BridgeError&&error.code===code;
const destructive=(args:string[])=>args[0]==="stop"||args[0]==="rm"||args[1]==="rm"||args[0]==="compose"&&args.includes("up");
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");

test("new runs use signed v2 state and official recorded index digests without changing envelope ownership",async()=>{
  const {base,root}=await setup(),{runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    const envelope=JSON.parse(await readFile(join(root,"run.json"),"utf8")),s=await state(root),compose=JSON.parse(await readFile(join(root,"compose.yaml"),"utf8"));
    assert.equal(envelope.format,1);assert.equal(s.version,2);
    const observed=JSON.parse(await readFile(new URL("../reports/immich-image-manifests.json",import.meta.url),"utf8"));
    for(const [service,repo]of [["immich-server","immich-server"],["immich-machine-learning","immich-machine-learning"]] as const){
      const record=observed.observations.find((o:any)=>o.image==="ghcr.io/immich-app/"+repo+":v3.3.5");
      assert.ok(record);assert.equal(record.publisher_annotations["org.opencontainers.image.revision"],LAB_SOURCE);
      assert.equal(compose.services[service].image,"ghcr.io/immich-app/"+repo+"@"+record.digest);
    }
    for(const service of Object.values<any>(compose.services))assert.match(service.image,/@sha256:[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(LAB_IMAGES));
    const result=await upLab(root,{docker:runner,http});
    assert.equal(result.manifest_version,2);assert.equal(result.image_reference_policy,"pinned_oci_index");
    assert.equal(result.configured_images_pinned,true);assert.equal(result.full_acceptance,false);assert.equal(result.execution_scope,"harness_only");
  }finally{await rm(base,{recursive:true,force:true});}
});

test("the frozen v1 run can start, check, stop without configuration files, restart and delete without image or key migration",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await legacyRun(root);
    const compose=await readFile(join(root,"compose.yaml")),env=await readFile(join(root,".env")),key=await readFile(join(root,".run.key")),vaultKey=await readFile(join(root,".vault.key"));
    const started=await upLab(root,{docker:runner,http}),checked=await checkLab(root,{docker:runner,http});
    assert.equal(started.manifest_version,1);assert.equal(checked.image_reference_policy,"legacy_tags");assert.equal(checked.configured_images_pinned,false);
    const images=fake.containers.map(c=>c.Config.Image).sort(),volumes=fake.volumes.map(v=>v.Name).sort();
    assert.ok(images.includes(legacyTemplate.services["immich-server"].image));assert.ok(!images.includes(LAB_IMAGES.server));
    await rm(join(root,".env"));await rm(join(root,"compose.yaml"));
    await downLab(root,false,{docker:runner});assert.deepEqual(fake.volumes.map(v=>v.Name).sort(),volumes);
    assert.equal((await state(root)).version,1);
    await writeFile(join(root,"compose.yaml"),compose);await writeFile(join(root,".env"),env);
    await upLab(root,{docker:runner,http});assert.deepEqual(fake.containers.map(c=>c.Config.Image).sort(),images);
    assert.deepEqual(await readFile(join(root,".run.key")),key);assert.deepEqual(await readFile(join(root,".vault.key")),vaultKey);
    const ended=await downLab(root,true,{docker:runner});assert.equal(ended.state,"destroyed");assert.equal(ended.host_files_removed,false);
    assert.equal((await state(root)).version,1);assert.equal(fake.volumes.length,0);
    assert.deepEqual(await readFile(join(root,".run.key")),key);assert.deepEqual(await readFile(join(root,".vault.key")),vaultKey);
    assert.ok(fake.calls.every(args=>!args.includes("--force")));
  }finally{await rm(base,{recursive:true,force:true});}
});

test("resource validation never mixes legacy tags and pinned references between manifest policies",async t=>{
  for(const legacy of [false,true])await t.test(legacy?"v1 rejects pinned substitution":"v2 rejects tag substitution",async()=>{
    const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http,calls}=fakeHttp(root);
    try{
      if(legacy)await legacyRun(root);await upLab(root,{docker:runner,http});
      fake.containers.find(c=>c.Config.Labels["com.docker.compose.service"]==="immich-server").Config.Image=
        legacy?LAB_IMAGES.server:legacyTemplate.services["immich-server"].image;
      fake.calls.length=0;calls.length=0;
      await assert.rejects(checkLab(root,{docker:runner,http}),isCode("lab_resources"));
      await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_resources"));
      assert.ok(!fake.calls.some(destructive));assert.equal(calls.length,0);assert.equal((await state(root)).delete_requested,undefined);
    }finally{await rm(base,{recursive:true,force:true});}
  });
});

test("an authenticated payload-version downgrade cannot reinterpret pinned configuration or existing containers",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root),{http}=fakeHttp(root);
  try{
    await upLab(root,{docker:runner,http});await signedRunEdit(root,s=>{s.version=1;});fake.calls.length=0;
    await assert.rejects(upLab(root,{docker:runner,http}),isCode("lab_changed"));
    await assert.rejects(checkLab(root,{docker:runner,http}),isCode("lab_changed"));assert.equal(fake.calls.length,0);
    await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_resources"));
    assert.ok(!fake.calls.some(destructive));assert.equal((await state(root)).delete_requested,undefined);
  }finally{await rm(base,{recursive:true,force:true});}
});

test("signed configuration drift is rejected against the selected canonical template before any Docker invocation",async t=>{
  const edits:[string,(spec:any)=>void][]=[
    ["different image",s=>{s.services["immich-server"].image="ghcr.io/immich-app/immich-server@sha256:"+"f".repeat(64);}],
    ["host photo bind",s=>{s.services["immich-server"].volumes=["/real/photos:/data"];}],
    ["foreign database",s=>{s.services["immich-server"].environment.DB_HOSTNAME="production";}],
    ["public port",s=>{s.services["immich-server"].ports[0].host_ip="0.0.0.0";}],
    ["extra command",s=>{s.services["immich-server"].command=["unexpected"]; }],
    ["extra env",()=>{}],
  ];
  for(const legacy of [false,true])for(const [name,edit]of edits)await t.test((legacy?"v1 ":"v2 ")+name,async()=>{
    const {base,root}=await setup(),{fake,runner}=fakeDocker(root);
    try{
      if(legacy)await legacyRun(root);
      await signedRunEdit(root,async s=>{
        if(name==="extra env"){
          const text=(await readFile(join(root,".env"),"utf8"))+"EXTRA=value\n";
          await writeFile(join(root,".env"),text);s.env_sha256=sha(text);
        }else{
          const body=JSON.parse(await readFile(join(root,"compose.yaml"),"utf8"));edit(body);
          const text=JSON.stringify(body,null,2)+"\n";await writeFile(join(root,"compose.yaml"),text);s.compose_sha256=sha(text);
        }
      });
      await assert.rejects(upLab(root,{docker:runner}),isCode("lab_changed"));
      await assert.rejects(checkLab(root,{docker:runner}),isCode("lab_changed"));assert.equal(fake.calls.length,0);
    }finally{await rm(base,{recursive:true,force:true});}
  });
});

test("unknown signed payload versions have no image-policy fallback before start or teardown",async()=>{
  const {base,root}=await setup(),{fake,runner}=fakeDocker(root);
  try{
    const s=await state(root);
    assert.equal(labCompose({id:s.id,project:s.project,port:s.port}).services["immich-server"].image,LAB_IMAGES.server);
    for(const version of [0,3,99,"2",null,undefined]){
      if(version===undefined)assert.equal(labCompose({...s,version:undefined}).services["immich-server"].image,LAB_IMAGES.server);
      else assert.throws(()=>labCompose({...s,version:version as any}),isCode("lab_manifest"));
      await signedRunEdit(root,value=>{(value as any).version=version;});
      await assert.rejects(upLab(root,{docker:runner}),isCode("lab_manifest"));
      await assert.rejects(downLab(root,true,{docker:runner}),isCode("lab_manifest"));assert.equal(fake.calls.length,0);
    }
  }finally{await rm(base,{recursive:true,force:true});}
});
