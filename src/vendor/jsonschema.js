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
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
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
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `${value} <= exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push({ path, message: `${value} >= exclusiveMaximum ${schema.exclusiveMaximum}` });
    }
    if (schema.multipleOf !== undefined && schema.multipleOf > 0
        && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-9) {
      errors.push({ path, message: `${value} is not a multiple of ${schema.multipleOf}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push({ path, message: 'array items are not unique' });
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`)));
    }
  }

  if (TYPES.object(value)) {
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) {
      errors.push({ path: path || '.', message: `object has ${count} properties, fewer than minProperties ${schema.minProperties}` });
    }
    if (schema.maxProperties !== undefined && count > schema.maxProperties) {
      errors.push({ path: path || '.', message: `object has ${count} properties, more than maxProperties ${schema.maxProperties}` });
    }
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

  // if/then/else. The `if` subschema is a test, never a source of errors of its
  // own: only the branch it selects contributes. Three schemas here carry
  // conditional rules -- including nfl-player-factual-record -- and until this
  // was implemented every one of them applied to nothing.
  if (schema.if !== undefined) {
    const matched = validate(value, schema.if, path).length === 0;
    const branch = matched ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validate(value, branch, path));
  }

  return errors;
}
