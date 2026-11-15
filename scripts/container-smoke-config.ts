/** Synthetic-only environment used by the real Docker smoke; no production credentials. */
export const containerSmokeEnvironment=Object.freeze({
  IMMICH_BASE_URL:"http://immich-smoke:2283/api",
  MCP_PUBLIC_BASE_URL:"https://mcp.example.test",
  ACCESS_ISSUER:"https://access.example.test",
  ACCESS_AUDIENCE:"container-smoke",
});
