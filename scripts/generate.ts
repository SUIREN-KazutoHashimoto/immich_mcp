import { applyPluginMethodSchemaCorrection } from "./plugin-method-response-correction.js";
import { applyWorkflowLogIndexCorrection } from "./workflow-log-response-correction.js";
import { applyTimelineStatusCorrection } from "./timeline-response-correction.js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { applyResponseShapeCorrections } from "./response-shape-corrections.js";
import { applyResponseCorrections } from "./response-corrections.js";
import type { Registry, Operation } from "../src/types.js";

const base = new URL("../immich_mcp_spec_v3.3.5/", import.meta.url);
const read = async (p: string) => JSON.parse(await readFile(new URL(p, base), "utf8"));
const bytes = await readFile(new URL("api/immich-openapi-v3.3.5.json", base));
const sha256 = createHash("sha256").update(bytes).digest("hex");
if (sha256 !== "632700b84590f6b197fe6ef9a8486db19d08a31a03cf10bc780925e8a32b6bb9")
  throw Error("Pinned OpenAPI integrity failure");
const api = JSON.parse(bytes.toString("utf8"));
const manifest = await read("api/source-manifest.json");
const inventory = await read("api/operation-inventory.json");
const overrides = await read("contracts/operation-overrides.v3.3.5.json");
if (manifest.sha256 !== sha256 || overrides.pinned_upstream.openapi_sha256 !== sha256)
  throw Error("Companion fingerprint mismatch");
const pointer = (ref: string) => ref.replace(/^#\//, "").split("/").reduce((v: any, k: string) => {
  if (!v || !Object.hasOwn(v, k.replace(/~1/g, "/").replace(/~0/g, "~"))) throw Error("Unresolved pointer: " + ref);
  return v[k.replace(/~1/g, "/").replace(/~0/g, "~")];
}, api);
const operations: Operation[] = [];
for (const [path, item] of Object.entries<any>(api.paths)) {
  for (const [method, definition] of Object.entries<any>(item)) {
    if (!["get","post","put","delete","patch","head","options","trace"].includes(method)) continue;
    const row = inventory.operations.find((o: any) => o.operation_id === definition.operationId);
    if (!row || row.http_method !== method.toUpperCase() || row.path !== path) throw Error("Inventory mismatch");
    operations.push({ operationId: definition.operationId, method: method.toUpperCase(), path,
      tag: definition.tags?.[0] ?? "", definition, parameters: [...(item.parameters ?? []), ...(definition.parameters ?? [])],
      auth: row.controller_auth });
  }
}
operations.sort((a,b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
if (operations.length !== 279 || new Set(operations.map(o=>o.operationId)).size !== 279) throw Error("Operation set mismatch");
const transportCorrections=JSON.parse(await readFile(new URL("../contracts/transport-overrides.v3.3.5.json",import.meta.url),"utf8"));
if(transportCorrections.format!=="immich-mcp-transport-corrections"||transportCorrections.version!==1||
  transportCorrections.immich_version!==manifest.version||transportCorrections.source_commit!==manifest.commit_sha||transportCorrections.openapi_sha256!==sha256)
  throw Error("Supplemental transport fingerprint mismatch");
const corrected=new Set<string>();
for(const extra of transportCorrections.operation_overrides){
  const target=overrides.operation_overrides.find((row:any)=>row.operation_id===extra.operation_id);
  if(!target||corrected.has(extra.operation_id)||target.http_method!==extra.http_method||target.api_relative_path!==extra.api_relative_path||
    target.openapi_operation_pointer!==extra.openapi_operation_pointer||!Array.isArray(extra.facts)||!Array.isArray(extra.requirements)||!Array.isArray(extra.source_urls))
    throw Error("Stale or duplicate supplemental transport correction");
  corrected.add(extra.operation_id);
  for(const [key,identity] of [["facts","fact_id"],["requirements","requirement_id"]] as const){
    for(const entry of extra[key]){
      if(typeof entry[identity]!=="string"||target[key].some((existing:any)=>existing[identity]===entry[identity]))
        throw Error("Duplicate supplemental transport requirement");
      target[key].push(entry);
    }
  }
  target.source_urls=[...new Set([...target.source_urls,...extra.source_urls])];
}
for (const override of overrides.operation_overrides) {
  const op = operations.find(o => o.operationId === override.operation_id);
  if (!op || op.path !== override.api_relative_path || op.method !== override.http_method ||
      pointer(override.openapi_operation_pointer).operationId !== op.operationId) throw Error("Stale override");
  op.override = override;
  const range=override.requirements.find((r:any)=>r.requirement_id==="range_forwarding");
  for(const name of range?.value?.request_headers ?? []) {
    if(!op.parameters.some(p=>p.in==="header" && p.name.toLowerCase()===name.toLowerCase()))
      op.parameters.push({in:"header",name,required:false,schema:{type:"string"}});
  }
}
const supplemental=JSON.parse(await readFile(new URL("../contracts/extra-secret-rules.json",import.meta.url),"utf8"));
if(supplemental.openapi_sha256!==sha256)throw Error("Supplemental secret fingerprint mismatch");
overrides.secret_field_rules.push(...supplemental.secret_field_rules);
for (const rule of overrides.secret_field_rules) {
  pointer(rule.schema_property_pointer);
  for (const binding of rule.bindings) if (!operations.some(o => o.operationId === binding.operation_id)) throw Error("Stale secret binding");
}
const authContexts=await read("contracts/auth-contexts.v3.3.5.json");
if(authContexts.target.openapi_sha256!==sha256)throw Error("Authentication contract fingerprint mismatch");
for(const row of [...authContexts.session_only_operations,...authContexts.shared_link_only_operations,...authContexts.public_operations,...authContexts.maintenance_runtime.operation_variants])
  if(!operations.some(o=>o.operationId===row.operation_id && o.method===row.method && o.path===row.path))throw Error("Stale authentication context contract");
const sync=JSON.parse(await readFile(new URL("../contracts/sync-records.v3.3.5.json",import.meta.url),"utf8"));
if(sync.source_commit!==manifest.commit_sha||sync.openapi_sha256!==sha256)throw Error("Sync record fingerprint mismatch");
const entities=new Set(api.components.schemas.SyncEntityType.enum as string[]);
const covered=[...Object.keys(sync.record_schemas),...sync.retired_entity_types] as string[];
if(covered.length!==entities.size||new Set(covered).size!==covered.length||covered.some(t=>!entities.has(t)))
  throw Error("Sync entity mapping inventory mismatch");
for(const schema of Object.values(sync.record_schemas) as string[])if(!Object.hasOwn(api.components.schemas,schema))throw Error("Missing sync record schema");
const responseCorrections=JSON.parse(await readFile(new URL("../contracts/response-corrections.v3.3.5.json",import.meta.url),"utf8"));
const activityStatusCorrectedOperations=applyResponseCorrections(operations,api.components.schemas,overrides.secret_field_rules,responseCorrections,{version:manifest.version,commit:manifest.commit_sha,sha256});
const clusterRequestResponseCorrections=JSON.parse(await readFile(new URL("../contracts/cluster-request-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const statusCorrectedOperations=applyResponseCorrections(activityStatusCorrectedOperations,api.components.schemas,overrides.secret_field_rules,clusterRequestResponseCorrections,{version:manifest.version,commit:manifest.commit_sha,sha256});
const shapeCorrections=JSON.parse(await readFile(new URL("../contracts/response-shape-corrections.v3.3.5.json",import.meta.url),"utf8"));
const shapeCorrectedOperations=applyResponseShapeCorrections(statusCorrectedOperations,overrides.secret_field_rules,shapeCorrections,{version:manifest.version,commit:manifest.commit_sha,sha256});
const timelineCorrection=JSON.parse(await readFile(new URL("../contracts/timeline-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const timelineCorrectedOperations=applyTimelineStatusCorrection(shapeCorrectedOperations,api.components.schemas,overrides.secret_field_rules,timelineCorrection,{version:manifest.version,commit:manifest.commit_sha,sha256});
const workflowLogIndexCorrection=JSON.parse(await readFile(new URL("../contracts/workflow-log-index-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const workflowLogCorrectedOperations=applyWorkflowLogIndexCorrection(timelineCorrectedOperations,api.components.schemas,workflowLogIndexCorrection,{version:manifest.version,commit:manifest.commit_sha,sha256});
const pluginMethodResponseCorrection=JSON.parse(await readFile(new URL("../contracts/plugin-method-response-correction.v3.3.5.json",import.meta.url),"utf8"));
const correctedOperations=applyPluginMethodSchemaCorrection(workflowLogCorrectedOperations,api.components.schemas,pluginMethodResponseCorrection,{version:manifest.version,commit:manifest.commit_sha,sha256});
const registry: Registry = {authContexts,version: manifest.version, commit: manifest.commit_sha, sha256,
  operations:correctedOperations, schemas: api.components.schemas, secretRules: overrides.secret_field_rules};
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/registry.json", import.meta.url), JSON.stringify(registry, null, 2) + "\n");
console.log(JSON.stringify({version: registry.version, operations: operations.length, missing:[], unexpected:[], duplicate:[], sha256}));
const browserScript=await readFile(new URL("../web/upload.js",import.meta.url),"utf8");
await writeFile(new URL("../src/generated/upload-script.json",import.meta.url),JSON.stringify(browserScript)+"\n");

const digest=(value:string|Buffer)=>createHash("sha256").update(value).digest("hex");
const integrityFiles={
  registry:"../src/generated/registry.json",
  upload_script:"../src/generated/upload-script.json",
  tools:"../immich_mcp_spec_v3.3.5/contracts/mcp-tool-contracts.json",
  sync:"../contracts/sync-records.v3.3.5.json"
};
const hashes=Object.fromEntries(await Promise.all(Object.entries(integrityFiles).map(async([name,path])=>[name,digest(await readFile(new URL(path,import.meta.url)))])));
await writeFile(new URL("../src/generated/integrity.json",import.meta.url),JSON.stringify({
  format:1,version:registry.version,source_sha256:sha256,registry_value_sha256:digest(JSON.stringify(registry)),assets:hashes
},null,2)+"\n");
