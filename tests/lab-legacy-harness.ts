// Test-only reconstruction of the frozen original v1 manifest and compose layout.
import { createHash,createHmac } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
import { join } from "node:path";
import frozen from "./lab-compose-v1.fixture.json" with {type:"json"};
import type { LabState } from "../src/integration-lab.js";
export const legacyTemplate=frozen;
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
export async function signedRunEdit(root:string,edit:(state:LabState)=>void|Promise<void>){
  const envelope=JSON.parse(await readFile(join(root,"run.json"),"utf8")),s=JSON.parse(envelope.payload) as LabState;
  await edit(s);const key=await readFile(join(root,".run.key"));
  try{
    const payload=JSON.stringify(s),mac=createHmac("sha256",key).update("immich-mcp-isolated-run-v1\n").update(payload).digest("hex");
    await writeFile(join(root,"run.json"),JSON.stringify({format:1,payload,mac})+"\n");
  }finally{key.fill(0);}
}
export async function legacyRun(root:string){
  await signedRunEdit(root,async s=>{
    s.version=1;
    const oldId=frozen.networks.isolated.labels["io.immich-mcp.integration.run"];
    const body=JSON.parse(JSON.stringify(frozen).replaceAll(frozen.name,s.project).replaceAll(oldId,s.id));
    body.services["immich-server"].ports[0].published=String(s.port);
    const text=JSON.stringify(body,null,2)+"\n";s.compose_sha256=sha(text);
    await writeFile(join(root,"compose.yaml"),text);
  });
}
