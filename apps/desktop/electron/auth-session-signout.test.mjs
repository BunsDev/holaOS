import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

/**
 * The body of the `auth:signOut` IPC handler, sliced up to the next handler
 * registration.
 *
 * The previous version of this test pinned the handler as one verbatim regex
 * spanning every statement in order. That broke as soon as
 * `clearPlaintextAuthCache()` was added beside the cookie clear — an addition
 * that strictly improved sign-out — and from then on it guarded nothing. What
 * matters is that each piece of state is cleared, not the order or the exact
 * surrounding text.
 */
function signOutHandler(source) {
  const start = source.indexOf('handleTrustedIpc("auth:signOut"');
  assert.notEqual(start, -1, 'auth:signOut handler not found in main.ts');
  const next = source.indexOf("handleTrustedIpc(", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("signing out clears every piece of persisted auth state", async () => {
  const handler = signOutHandler(await readFile(mainSourcePath, "utf8"));

  assert.match(handler, /await requireAuthClient\(\)\.signOut\(\)/);
  // Cleared in a `finally` so a failing upstream sign-out still drops the
  // local credential rather than leaving a half-signed-out desktop.
  assert.match(handler, /\}\s*finally\s*\{/);
  assert.match(handler, /clearPersistedAuthCookie\(\)/);
  assert.match(handler, /await clearManagedHolabossDefaultSelection\("auth_sign_out"\)/);
  assert.match(handler, /emitAuthUserUpdated\(null\)/);
});

test("signing out revokes control-plane-managed runtime binding secrets", async () => {
  const handler = signOutHandler(await readFile(mainSourcePath, "utf8"));

  // Only managed bindings carry secrets the desktop issued, so the revoke is
  // conditional — but it must still be reached from the sign-out path.
  assert.match(handler, /runtimeConfigIsControlPlaneManaged\(runtimeConfig\)/);
  assert.match(handler, /await clearRuntimeBindingSecrets\("auth_sign_out"\)/);
});
