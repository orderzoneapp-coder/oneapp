// Browser/runtime commands are central-authority-only by default. Node contract
// tests have no window and opt into only the pure/local repository boundary.
let centralAuthorityMode = typeof window !== 'undefined';
let activeProof = null;

export function enableCentralAuthorityMode() {
  centralAuthorityMode = true;
}

export function disableCentralAuthorityModeForLegacyTest() {
  centralAuthorityMode = false;
  activeProof = null;
}

export function isCentralAuthorityMode() {
  return centralAuthorityMode;
}

export function assertOfficialCommandAuthority(commandType) {
  if (!centralAuthorityMode) return;
  if (!activeProof || activeProof.commandType !== String(commandType || '')) {
    throw new Error(`ORDERQ_CENTRAL_AUTHORITY_REQUIRED:${commandType}`);
  }
}

export async function withOfficialCommandAuthority(proof, operation) {
  if (!proof?.leaseToken || !proof?.commandType) throw new Error('ORDERQ_CENTRAL_AUTHORITY_PROOF_INVALID');
  if (activeProof) throw new Error('ORDERQ_CENTRAL_AUTHORITY_NESTED_COMMAND_FORBIDDEN');
  activeProof = proof;
  try {
    return await operation();
  } finally {
    activeProof = null;
  }
}
