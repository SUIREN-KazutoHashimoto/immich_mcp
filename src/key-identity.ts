const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// API key IDs are UUID values; their hexadecimal letter case is not identity.
// Credential secrets and opaque context/file/result handles remain exact strings.
export function sameApiKeyId(left:unknown,right:unknown):boolean{
  return typeof left==="string"&&typeof right==="string"&&uuid.test(left)&&uuid.test(right)&&left.toLowerCase()===right.toLowerCase();
}
