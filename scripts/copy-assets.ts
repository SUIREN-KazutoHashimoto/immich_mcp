import { copyFile,mkdir,readFile,writeFile } from "node:fs/promises";
import { runtimeIntegrity } from "../src/runtime-integrity.js";
const root=new URL("../",import.meta.url);
const assets=[
  "web/image-viewer.html",
  "src/generated/registry.json","src/generated/upload-script.json","src/generated/integrity.json",
  "contracts/sync-records.v3.3.5.json","contracts/synthetic-video.v1.json","immich_mcp_spec_v3.3.5/api/immich-openapi-v3.3.5.json",
  "immich_mcp_spec_v3.3.5/contracts/mcp-tool-contracts.json"
];
if(await runtimeIntegrity(new URL("src/runtime-integrity.ts",root))!=="ok")throw Error("Runtime source integrity failed; run pnpm generate after reviewing inputs");
for(const path of assets){
  const target=new URL("dist/"+path,root);await mkdir(new URL("./",target),{recursive:true});await copyFile(new URL(path,root),target);
}
if(await runtimeIntegrity(new URL("dist/src/runtime-integrity.js",root))!=="ok")throw Error("Runtime bundle integrity failed");
const revision=process.env.MCP_BUILD_REVISION||null;
if(revision!==null&&!/^[0-9a-f]{40}$/.test(revision))throw Error("MCP_BUILD_REVISION must be a full lowercase Git commit");
const version=JSON.parse(await readFile(new URL("package.json",root),"utf8")).version;
await writeFile(new URL("dist/src/build-info.json",root),JSON.stringify({version,revision})+"\n");
console.log(JSON.stringify({runtime_assets:assets.length,integrity:"ok"}));
