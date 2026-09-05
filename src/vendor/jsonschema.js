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

// Resolve a local JSON pointer ("#/$defs/thing") against the root schema.
// Returns undefined when it does not resolve, which the caller reports rather
// than passing over: a $ref nobody follows is a rule that enforces nothing,
// which is the failure this validator was found to have.
function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let node = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * Returns an array of { path, message }. Empty array means valid.
 *
 * `root` is the document "#/..." pointers resolve against; it defaults to the
 * schema itself and is threaded through every recursion so a $ref inside a
 * subschema still finds the top-level $defs.
 */
export function validate(value, schema, path = '', root = schema) {
  const errors = [];
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [{ path, message: 'schema forbids any value' }];

  // A reference stands in for the schema it names. An external one -- a path to
  // another file -- cannot be followed here: this validator is handed a schema
  // object, not a location, and giving it filesystem reach would be a different
  // contract. Report it rather than ignore it.
  if (schema.$ref !== undefined) {
    const target = resolvePointer(root, schema.$ref);
    if (target === undefined) {
      return [{ path, message: `cannot resolve $ref ${JSON.stringify(schema.$ref)}`
        + (String(schema.$ref).startsWith('#') ? '' : ' (external references are not resolvable here; inline it or pre-resolve)') }];
    }
    return validate(value, target, path, root);
  }

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
      value.forEach((item, i) => errors.push(...validate(item, schema.items, `${path}[${i}]`, root)));
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
      if (key in value) errors.push(...validate(value[key], sub, path ? `${path}.${key}` : key, root));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push({ path: path || '.', message: `property "${key}" is not declared in the schema` });
        }
      }
    } else if (TYPES.object(schema.additionalProperties)) {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in props)) errors.push(...validate(v, schema.additionalProperties, path ? `${path}.${key}` : key, root));
      }
    }
  }

  for (const sub of schema.allOf ?? []) errors.push(...validate(value, sub, path, root));

  // if/then/else. The `if` subschema is a test, never a source of errors of its
  // own: only the branch it selects contributes. Three schemas here carry
  // conditional rules -- including nfl-player-factual-record -- and until this
  // was implemented every one of them applied to nothing.
  if (schema.if !== undefined) {
    const matched = validate(value, schema.if, path, root).length === 0;
    const branch = matched ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...validate(value, branch, path, root));
  }

  // anyOf: at least one branch accepts. oneOf: exactly one does -- two branches
  // both accepting means the schema does not say what it appears to say.
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => validate(value, sub, path, root).length === 0)) {
    errors.push({ path, message: `value matches none of the ${schema.anyOf.length} anyOf branches` });
  }
  if (Array.isArray(schema.oneOf)) {
    const accepted = schema.oneOf.filter((sub) => validate(value, sub, path, root).length === 0).length;
    if (accepted !== 1) {
      errors.push({ path, message: `value matches ${accepted} of the ${schema.oneOf.length} oneOf branches, expected exactly 1` });
    }
  }

  return errors;
}
