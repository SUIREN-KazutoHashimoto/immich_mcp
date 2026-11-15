// Existing 279 API operations, reviewed against immutable upstream sources.
// Source/schema evidence: reports/immich-3.4.1-compatibility.json.
export const supportedImmichVersions:readonly string[]=Object.freeze(["3.3.5","3.3.6","3.4.0","3.4.1"]);

export function supportsImmichVersion(version:{major:number;minor:number;patch:number;prerelease:unknown}):boolean {
  return version.prerelease===null&&supportedImmichVersions.includes(`${version.major}.${version.minor}.${version.patch}`);
}
export function upstreamAvailable(state:string):boolean {return state==="ok"||state==="version_mismatch";}
export interface CompatibilityWarning {
  code:"unverified_immich_version";observed_version:string|null;reviewed_versions:string[];api_contract_version:"3.3.5";message:string;
}
export function compatibilityWarnings(health:{state:string;observed_version?:string|null}):CompatibilityWarning[] {
  if(health.state!=="version_mismatch")return [];
  return [{code:"unverified_immich_version",observed_version:typeof health.observed_version==="string"&&health.observed_version.length<=64&&/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(health.observed_version)?health.observed_version:null,reviewed_versions:[...supportedImmichVersions],
    api_contract_version:"3.3.5",message:"This Immich version has not been verified with this MCP server. Requests are allowed, but some API operations or response fields may be incompatible. Tell the user this limitation; do not claim the request failed or retry solely because of this warning."}];
}
