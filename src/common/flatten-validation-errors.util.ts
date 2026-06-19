import type { ValidationError } from 'class-validator';

// Flattens class-validator's nested ValidationError tree into readable
// "path: constraint" strings — deliberately omits error.value, since for
// this app that can be WhatsApp message text/PII, and these strings get
// logged server-side when a webhook payload fails validation.
export function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): string[] {
  return errors.flatMap((error) => {
    const path = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    const ownMessages = error.constraints
      ? Object.values(error.constraints).map((message) => `${path}: ${message}`)
      : [];
    const childMessages = error.children?.length
      ? flattenValidationErrors(error.children, path)
      : [];
    return [...ownMessages, ...childMessages];
  });
}
