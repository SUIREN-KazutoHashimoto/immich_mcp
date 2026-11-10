// Reviewed against the upstream OpenAPI and implementation diff recorded in
// reports/immich-3.3.6-compatibility.json. The API contract remains 3.3.5.
export const supportedImmichVersions:readonly string[]=Object.freeze(["3.3.5","3.3.6"]);

export function supportsImmichVersion(version:{major:number;minor:number;patch:number;prerelease:unknown}):boolean {
  return version.prerelease===null&&supportedImmichVersions.includes(`${version.major}.${version.minor}.${version.patch}`);
}
