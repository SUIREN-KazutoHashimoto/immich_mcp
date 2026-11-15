import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Operation,Schema } from "../src/types.js";

export const IMMICH_341_COMMIT="22b95194c80a2f2e6201093916b6c8c3d6d271dd";
export const IMMICH_341_SHA256="e98acf387b5ffe2c239cb6619a82ef8ce7092447baab22c1f223744aad79858e";
export const changedSchemas=[
  "AdminConfigBackupsDto","AdminConfigDto","ImageFormat","JobName","MaintenanceAction","MaintenanceStatusResponseDto",
  "Permission","PublicConfigDto","QueueStatisticsDto","ServerFeaturesDto","ServerVersionResponseDto","SetMaintenanceModeDto",
  "UserConfigDto","UserConfigOAuthDto","WorkflowTrigger"
];
const permissions:Record<string,{permission:string;symbol:string;line:number}>={
  clusterGroupRegeneratePeople:{permission:"clusterGroup.admin",symbol:"ClusterGroupAdmin",line:105},
  createNotification:{permission:"notification.create",symbol:"NotificationCreate",line:30},
  getNotificationTemplateAdmin:{permission:"notification.create",symbol:"NotificationCreate",line:54},
  sendTestEmailAdmin:{permission:"notification.create",symbol:"NotificationCreate",line:42}
};
const metadata=new Set(["description","example","deprecated","summary","tags","x-immich-history","x-immich-state","x-immich-permission"]);
function contract(value:any):any {
  if(Array.isArray(value))return value.map(contract);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!metadata.has(key)).map(([key,item])=>[key,contract(item)]));
}
// Extend only the reviewed schema delta; keep the original 279-operation surface,
// its authentication adapters, secret rules, and source-contract corrections.
export function applyImmich341Compatibility(operations:Operation[],schemas:Record<string,Schema>,base:any,bytes:Buffer) {
  assert.equal(createHash("sha256").update(bytes).digest("hex"),IMMICH_341_SHA256,"Immich 3.4.1 source fingerprint");
  const api=JSON.parse(bytes.toString("utf8"));assert.equal(api.info.version,"3.4.1");
  const latest=new Map<string,any>();
  for(const [path,item]of Object.entries<any>(api.paths))for(const [method,definition]of Object.entries<any>(item))
    if(["get","post","put","patch","delete"].includes(method))latest.set(definition.operationId,{path,method:method.toUpperCase(),definition});
  assert.equal(latest.size,287);
  const baseOperations=new Map<string,any>();
  for(const [path,item]of Object.entries<any>(base.paths))for(const [method,definition]of Object.entries<any>(item))
    if(["get","post","put","patch","delete"].includes(method))baseOperations.set(definition.operationId,{path,method:method.toUpperCase(),definition});
  assert.equal(baseOperations.size,279);
  for(const [id,old]of baseOperations) {
    const next=latest.get(id);assert.ok(next,id+" was removed");assert.equal(next.path,old.path);assert.equal(next.method,old.method);
    assert.deepEqual(contract(next.definition),contract(old.definition),id+" has an unreviewed contract change");
    const oldPermission=old.definition["x-immich-permission"],nextPermission=next.definition["x-immich-permission"];
    if(oldPermission!==nextPermission)assert.equal(nextPermission,permissions[id]?.permission,id+" permission delta");
  }
  const removed=Object.keys(base.components.schemas).filter(name=>!Object.hasOwn(api.components.schemas,name)).sort();
  assert.deepEqual(removed,["PublicConfigThemeDto","UserConfigThemeDto"]);
  const actual=Object.keys(base.components.schemas).filter(name=>Object.hasOwn(api.components.schemas,name)&&JSON.stringify(base.components.schemas[name])!==JSON.stringify(api.components.schemas[name])).sort();
  assert.deepEqual(actual,[...changedSchemas].sort(),"Review schema deltas before widening compatibility");
  const output=structuredClone(schemas);
  for(const name of changedSchemas) {
    const old=base.components.schemas[name],next=api.components.schemas[name];assert.ok(next);
    if(old.enum) {
      assert.equal(old.type,next.type);assert.ok(old.enum.every((item:any)=>next.enum.includes(item)));
      output[name]=structuredClone(next);
    } else {
      assert.equal(old.type,"object");assert.equal(next.type,"object");
      const merged=structuredClone(next);
      merged.properties={...structuredClone(old.properties),...merged.properties};
      // The union accepts both reviewed response generations. Each property's
      // type remains constrained; unknown fields are still withheld.
      merged.required=(old.required??[]).filter((key:string)=>(next.required??[]).includes(key));
      output[name]=merged;
    }
  }
  const visit=(value:any):void=>{
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=="object")return;
    if(typeof value.$ref==="string"&&value.$ref.startsWith("#/components/schemas/")){
      const name=value.$ref.split("/").at(-1)!;
      if(!Object.hasOwn(output,name)){assert.ok(api.components.schemas[name]);output[name]=structuredClone(api.components.schemas[name]);visit(output[name]);}
    }
    Object.values(value).forEach(visit);
  };
  changedSchemas.forEach(name=>visit(output[name]));
  const extended=structuredClone(operations);
  for(const [id,change]of Object.entries(permissions)){
    const op=extended.find(o=>o.operationId===id)!;assert.ok(op);
    const sourceUrl="https://github.com/immich-app/immich/blob/"+IMMICH_341_COMMIT+"/"+op.auth.source_path;
    op.auth.version_overrides=[{immich_versions:["3.4.0","3.4.1"],api_permission_mode:"explicit",
      effective_api_key_permission:change.permission,admin_only:op.auth.admin_only,
      auth_decorator:"@Authenticated({ permission: Permission."+change.symbol+(op.auth.admin_only?", admin: true":"")+" })",
      source_url:sourceUrl,method_line:change.line}];
  }
  return {operations:extended,schemas:output};
}
