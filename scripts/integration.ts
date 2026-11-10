import { createWorkflowFixtures } from "../src/integration-workflow-fixtures.js";
import { createLifecycleFixtures } from "../src/integration-lifecycle-fixtures.js";
import { createPeopleFixtures } from "../src/integration-people-fixtures.js";
import { createDiscoveryFixtures } from "../src/integration-discovery-fixtures.js";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareLab,upLab,checkLab,downLab } from "../src/integration-lab.js";
import { bootstrapLab } from "../src/integration-bootstrap.js";
import { createFeatureFixtures } from "../src/integration-fixtures.js";
import { createVideoFixtures } from "../src/integration-video-fixtures.js";
import { createUserFixtures } from "../src/integration-user-fixtures.js";
import { createSharingFixtures } from "../src/integration-sharing-fixtures.js";
import { createCollectionFixtures } from "../src/integration-collection-fixtures.js";
import { createSyncFixtures } from "../src/integration-sync-fixtures.js";
import { createAuthFixtures } from "../src/integration-auth-fixtures.js";
import { BridgeError } from "../src/types.js";

export async function integrationCommand(args:string[]){
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{directory:{type:"string"},port:{type:"string"},"delete-volumes":{type:"boolean"}}});
  if(positionals.length!==1||!values.directory)throw new BridgeError("usage","Use prepare, up, check, bootstrap, fixtures, auth-fixtures, video-fixtures, sync-fixtures, collection-fixtures, sharing-fixtures, user-fixtures, discovery-fixtures, people-fixtures, lifecycle-fixtures, workflow-fixtures or down with --directory ABSOLUTE_RUN_DIRECTORY");
  const command=positionals[0],allowed=command==="prepare"?["directory","port"]:command==="down"?["directory","delete-volumes"]:["directory"];
  if(Object.keys(values).some(key=>!allowed.includes(key)))throw new BridgeError("usage","Unexpected option for laboratory command");
  if(command==="prepare"){
    if(values.port!==undefined&&!/^[0-9]+$/.test(values.port))throw new BridgeError("usage","Use a nonprivileged local port");
    return prepareLab(values.directory,values.port===undefined?undefined:Number(values.port));
  }
  if(command==="up")return upLab(values.directory);
  if(command==="check")return checkLab(values.directory);
  if(command==="bootstrap")return bootstrapLab(values.directory);
  if(command==="fixtures")return createFeatureFixtures(values.directory);
  if(command==="auth-fixtures")return createAuthFixtures(values.directory);
  if(command==="video-fixtures")return createVideoFixtures(values.directory);
  if(command==="sync-fixtures")return createSyncFixtures(values.directory);
  if(command==="collection-fixtures")return createCollectionFixtures(values.directory);
  if(command==="sharing-fixtures")return createSharingFixtures(values.directory);
  if(command==="user-fixtures")return createUserFixtures(values.directory);
  if(command==="discovery-fixtures")return createDiscoveryFixtures(values.directory);
  if(command==="people-fixtures")return createPeopleFixtures(values.directory);
  if(command==="lifecycle-fixtures")return createLifecycleFixtures(values.directory);
  if(command==="workflow-fixtures")return createWorkflowFixtures(values.directory);
  if(command==="down")return downLab(values.directory,values["delete-volumes"] ?? false);
  throw new BridgeError("usage","Expected prepare, up, check, bootstrap, fixtures, auth-fixtures, video-fixtures, sync-fixtures, collection-fixtures, sharing-fixtures, user-fixtures, discovery-fixtures, people-fixtures, lifecycle-fixtures, workflow-fixtures or down");
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  integrationCommand(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(JSON.stringify({error:{code:error instanceof BridgeError?error.code:"integration_failed"}}));process.exitCode=1;
  });
}
