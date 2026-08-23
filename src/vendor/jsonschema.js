// Minimal JSON Schema (draft 2020-12 subset) validator.
// Dependency-free by design: Pro-Scout ships no package.json and CI runs bare node.
// Supports exactly the keywords used by schema/*.json — see validate-repo.mjs for the audit.

const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

const FORMATS = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:/,
};

function typeOk(value, type) {
  const list = Array.isArray(type) ? type : [type];
  return list.some((t) => (TYPES[t] ? TYPES[t](value) : true));
}

/** Returns an array of { path, message }. Empty array means valid. */
export function validate(value, schema, path = '') {
  const errors = [];
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [{ path, message: 'schema forbids any value' }];

  if (schema.type !== undefined && !typeOk(value, schema.type)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    return [{ path, message: `expected type ${JSON.stringify(schema.type)}, got ${got}` }];
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format].test(value)) {
      errors.push({ path, message: `string is not a valid ${schema.format}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `${value} > maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (TYPES.object(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path: path || '.', message: `missing required property "${key}"` });
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(value[key], sub, path ? `${path}.${key}` : key));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push({ path: path || '.', message: `property "${key}" is not declared in the schema` });
        }
      }
    } else if (TYPES.object(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) errors.push(...validate(v, schema.additionalProperties, path ? `${path}.${key}` : key));
      }
    }
  }

  for (const sub of schema.allOf ?? []) errors.push(...validate(value, sub, path));

  return errors;
}
