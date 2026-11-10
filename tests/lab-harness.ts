import assert from "node:assert/strict";
import { mkdtemp,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLab,type DockerRunner } from "../src/integration-lab.js";
import { BridgeError } from "../src/types.js";
const label="io.immich-mcp.integration.run";
export async function state(root:string){return JSON.parse(JSON.parse(await readFile(join(root,"run.json"),"utf8")).payload);}
export async function setup(){
  const base=await mkdtemp(join(tmpdir(),"immich-isolated-lab-")),root=join(base,"run");
  await prepareLab(root);return {base,root};
}
export function fakeDocker(root:string){
  let next=1;
  const id=()=>String(next++).padStart(64,"0");
  const fake={engine:"isolated-engine-1",calls:[] as string[][],containers:[] as any[],volumes:[] as any[],networks:[] as any[],
    before:undefined as undefined|((args:string[])=>void),upFailure:false,removeFailure:false};
  const clone=(v:any)=>JSON.parse(JSON.stringify(v));
  const runner:DockerRunner=async args=>{
    fake.calls.push([...args]);fake.before?.(args);
    if(args[0]==="info")return args[2]==="{{.OSType}}"?"linux":fake.engine;
    if(args[0]==="ps")return fake.containers.map(c=>c.Id).join("\n");
    if(args[0]==="volume"&&args[1]==="ls")return fake.volumes.map(v=>v.Name).join("\n");
    if(args[0]==="network"&&args[1]==="ls")return fake.networks.map(n=>n.Id).join("\n");
    if(args[0]==="inspect")return JSON.stringify(clone(args.slice(3).map(value=>fake.containers.find(c=>c.Id===value)).filter(Boolean)));
    if(args[1]==="inspect"){
      const collection=args[0]==="volume"?fake.volumes:fake.networks;
      return JSON.stringify(clone(args.slice(2).map(value=>collection.find(c=>c.Name===value||c.Id===value)).filter(Boolean)));
    }
    if(args[0]==="compose"){
      assert.equal(args[1],"--env-file");assert.equal(args[2],join(root,".env"));assert.equal(args[3],"--project-name");
      assert.equal(args[5],"--file");assert.equal(args[6],join(root,"compose.yaml"));
      if(args[7]==="config")return "";
      assert.equal(args[7],"up");const spec=JSON.parse(await readFile(join(root,"compose.yaml"),"utf8"));
      const common={"com.docker.compose.project":spec.name,[label]:spec.networks.isolated.labels[label]};
      if(!fake.volumes.length)fake.volumes=Object.values<any>(spec.volumes).map(v=>({Name:v.name,Driver:"local",Options:null,Labels:{...common}}));
      if(!fake.networks.length)fake.networks=Object.values<any>(spec.networks).map(n=>({Name:n.name,Id:id(),Driver:"bridge",Internal:n.internal??false,Labels:{...common},Containers:{}}));
      for(const network of fake.networks)network.Containers={};
      fake.containers=Object.entries<any>(spec.services).map(([name,service])=>{
        const container=id(),[volume,target]=service.volumes[0].split(":");
        const networks=Object.fromEntries(service.networks.map((n:string)=>[spec.networks[n].name,{NetworkID:fake.networks.find(x=>x.Name===spec.networks[n].name).Id}]));
        for(const network of fake.networks)if(networks[network.Name])network.Containers[container]={Name:name};
        return {Id:container,Image:"sha256:"+id(),Config:{Image:service.image,Labels:{...common,"com.docker.compose.service":name}},
          HostConfig:{NetworkMode:spec.name+"_isolated",Privileged:false},Mounts:[{Type:"volume",Name:spec.volumes[volume].name,Destination:target}],
          State:{Running:true,Health:{Status:"healthy"}},NetworkSettings:{Networks:networks,Ports:service.ports?{"2283/tcp":[{HostIp:"127.0.0.1",HostPort:service.ports[0].published}]}:{}}};
      });
      if(fake.upFailure){fake.upFailure=false;throw new BridgeError("docker_failed","Simulated partial infrastructure start");}
      return "";
    }
    if(args[0]==="stop"){fake.containers.find(c=>c.Id===args[3]).State.Running=false;return args[3]!;}
    if(args[0]==="rm"){
      if(fake.removeFailure){fake.removeFailure=false;throw new BridgeError("docker_failed","Simulated removal failure");}
      fake.containers=fake.containers.filter(c=>c.Id!==args[1]);for(const n of fake.networks)delete n.Containers[args[1]!];return args[1]!;
    }
    if(args[0]==="network"&&args[1]==="rm"){fake.networks=fake.networks.filter(n=>n.Id!==args[2]);return args[2]!;}
    if(args[0]==="volume"&&args[1]==="rm"){fake.volumes=fake.volumes.filter(v=>v.Name!==args[2]);return args[2]!;}
    throw Error("Unexpected fake Docker command");
  };
  return {fake,runner};
}
export function fakeHttp(root:string,value:any={major:3,minor:3,patch:5,prerelease:null}){
  const calls:string[]=[];
  const http=(async(input:any,init:any)=>{
    calls.push(String(input));assert.equal(String(input),"http://127.0.0.1:22835/api/server/version");assert.equal(init.redirect,"manual");
    assert.ok(init.signal instanceof AbortSignal);return Response.json(value);
  }) as typeof fetch;
  return {http,calls};
}
