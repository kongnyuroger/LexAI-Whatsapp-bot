import { timingSafeEqual } from 'crypto';

// Constant-time string comparison so secret/signature validation doesn't
// leak timing information, mirroring the pattern lexai-backend's own
// ServiceAuthGuard uses for the same reason.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
