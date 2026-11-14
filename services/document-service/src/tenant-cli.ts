/**
 * `pnpm --filter @docedit/document-service tenant <command>`: the operator's registration of
 * tenants in phase 1a (BE-012 criterion 1; administration endpoints are UX-076). Connects with
 * DOCEDIT_DATABASE_URL. A new API key is printed once and only its SHA-256 is stored.
 *
 *   tenant create <tenant-uuid> <name>
 *   tenant add-key <tenant> <user|service> <kid> <ES256|EdDSA|RS256> <public-jwk-json> [issuer]
 *   tenant remove-key <tenant> <kid>
 *   tenant add-api-key <tenant> [label]
 *   tenant expire-api-key <tenant> <key-id> <rfc3339-time>
 *   tenant remove-api-key <tenant> <key-id>
 *   tenant add-origin <tenant> <origin>
 *   tenant remove-origin <tenant> <origin>
 */
import { createPool } from './storage/db.ts';
import { PgTenantRegistry } from './control-plane/tenants.ts';
import { hashSecret } from './control-plane/tenants.ts';
import { newApiKey } from './control-plane/tokens.ts';
import { isAlgorithm } from './control-plane/jwt.ts';

const url = process.env['DOCEDIT_DATABASE_URL'];
if (!url) {
  console.error('Set DOCEDIT_DATABASE_URL to the service database.');
  process.exit(2);
}
const [command, tenant, ...args] = process.argv.slice(2);
const pool = createPool({ connectionString: url });
const registry = new PgTenantRegistry(pool);
try {
  if (!command || !tenant) throw new Error('usage: tenant <command> <tenant> ...');
  switch (command) {
    case 'create':
      await registry.putTenant(tenant, args[0] ?? tenant);
      break;
    case 'add-key': {
      const [use, kid, alg, jwk, issuer] = args;
      if ((use !== 'user' && use !== 'service') || !kid || !isAlgorithm(alg) || !jwk)
        throw new Error('add-key <tenant> <user|service> <kid> <alg> <public-jwk-json> [issuer]');
      await registry.addKey(tenant, {
        kid,
        use,
        alg,
        jwk: JSON.parse(jwk),
        ...(issuer ? { issuer } : {}),
      });
      break;
    }
    case 'remove-key':
      console.log((await registry.removeKey(tenant, args[0] ?? '')) ? 'removed' : 'no such key');
      break;
    case 'add-api-key': {
      const key = newApiKey(tenant);
      await registry.addApiKey(tenant, {
        id: key.id,
        secretHash: hashSecret(key.secret),
        ...(args[0] ? { label: args[0] } : {}),
      });
      // Printed once; the registry keeps only the hash.
      console.log(key.credential);
      break;
    }
    case 'expire-api-key':
      await registry.expireApiKey(tenant, args[0] ?? '', Date.parse(args[1] ?? ''));
      break;
    case 'remove-api-key':
      console.log((await registry.removeApiKey(tenant, args[0] ?? '')) ? 'removed' : 'no such key');
      break;
    case 'add-origin':
      await registry.addOrigin(tenant, args[0] ?? '');
      break;
    case 'remove-origin':
      console.log(
        (await registry.removeOrigin(tenant, args[0] ?? '')) ? 'removed' : 'no such origin',
      );
      break;
    default:
      throw new Error(`unknown command ${command}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await pool.end();
}
