/** Synthetic-only environment used by the real Docker smoke; no production credentials. */
export const containerSmokeEnvironment=Object.freeze({
  IMMICH_BASE_URL:"http://immich-smoke:2283/api",
  IMMICH_EXPECTED_VERSION:"3.3.5",
  MCP_PUBLIC_BASE_URL:"https://mcp.example.test",
  ACCESS_ISSUER:"https://access.example.test",
  ACCESS_AUDIENCE:"container-smoke",
  ACCESS_JWKS_URL:"https://access.example.test/cdn-cgi/access/certs",
  VAULT_MASTER_KEY_FILE:"/run/secrets/vault_master_key",
  STORAGE_PATH:"/data",
  DATABASE_PATH:"/data/vault.sqlite"
});
