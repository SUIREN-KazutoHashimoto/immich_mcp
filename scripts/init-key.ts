import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute,resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function createMasterKey(destination:string){
  if(!destination||!isAbsolute(destination))throw Error("Supply an absolute key-file path outside the data volume");
  await writeFile(destination,randomBytes(32),{flag:"wx",mode:0o600});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    if(process.argv.length!==3)throw Error("Expected one key-file path");
    await createMasterKey(process.argv[2]!);
    console.log("Created a 32-byte master-key file. Store it separately from database backups.");
  }catch{
    console.error("Key creation failed. Supply one absolute path with an existing parent; existing files are never overwritten.");
    process.exitCode=1;
  }
}
