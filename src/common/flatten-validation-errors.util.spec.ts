import type { ValidationError } from 'class-validator';
import { flattenValidationErrors } from './flatten-validation-errors.util';

describe('flattenValidationErrors', () => {
  it('formats a top-level constraint failure', () => {
    const errors: ValidationError[] = [
      {
        property: 'object',
        constraints: { isString: 'object must be a string' },
      },
    ];

    expect(flattenValidationErrors(errors)).toEqual([
      'object: object must be a string',
    ]);
  });

  it('recurses into nested children with dotted paths', () => {
    const errors: ValidationError[] = [
      {
        property: 'entry',
        children: [
          {
            property: '0',
            children: [
              {
                property: 'id',
                constraints: { isString: 'id must be a string' },
              },
            ],
          },
        ],
      },
    ];

    expect(flattenValidationErrors(errors)).toEqual([
      'entry.0.id: id must be a string',
    ]);
  });

  it('never includes error.value in the output', () => {
    const errors: ValidationError[] = [
      {
        property: 'text',
        value: { body: 'sensitive message content' },
        constraints: { isObject: 'text must be an object' },
      },
    ];

    const output = flattenValidationErrors(errors).join(' ');
    expect(output).not.toContain('sensitive message content');
  });
});
