import { timingSafeEqualStrings } from './timing-safe-equal.util';

describe('timingSafeEqualStrings', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStrings('shared-secret', 'shared-secret')).toBe(true);
  });

  it('returns false for different strings of the same length', () => {
    expect(timingSafeEqualStrings('shared-secret', 'shared-secreT')).toBe(
      false,
    );
  });

  it('returns false for strings of different lengths, without throwing', () => {
    expect(timingSafeEqualStrings('short', 'a-much-longer-string')).toBe(false);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeEqualStrings('', 'non-empty')).toBe(false);
  });

  it('returns true when both strings are empty', () => {
    expect(timingSafeEqualStrings('', '')).toBe(true);
  });
});
