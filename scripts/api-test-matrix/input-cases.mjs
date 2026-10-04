// These are test-design partitions, not requests or predictions of HTTP status.
export function resolveReference(document, value) {
  if (!value || typeof value !== "object" || !value.$ref) return value;
  if (!value.$ref.startsWith("#/")) throw new Error(`External reference: ${value.$ref}`);
  const target = value.$ref.slice(2).split("/").reduce((current, segment) => (
    current?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
  ), document);
  if (target === undefined) throw new Error(`Unresolved reference: ${value.$ref}`);
  const { $ref, ...siblings } = value;
  return { ...resolveReference(document, target), ...siblings };
}

function schemaTypes(schema) {
  if (schema.type) return Array.isArray(schema.type) ? schema.type : [schema.type];
  const values = schema.enum ?? (Object.hasOwn(schema, "const") ? [schema.const] : []);
  return [...new Set(values.map((value) => value === null ? "null" : typeof value))];
}

export function choicesFor(document, value, required) {
  const schema = resolveReference(document, value) ?? {};
  const choices = required ? [] : [{ kind: "omitted" }];
  if (Object.hasOwn(schema, "const")) choices.push({ kind: "literal", value: schema.const });
  else if (schema.enum) choices.push(...schema.enum.map((item) => ({ kind: "literal", value: item })));
  else {
    const types = schemaTypes(schema);
    if (types.includes("boolean")) choices.push({ kind: "literal", value: false }, { kind: "literal", value: true });
    if (types.includes("null")) choices.push({ kind: "literal", value: null });
    if (!types.length || types.some((type) => type !== "boolean" && type !== "null")) {
      choices.push({ kind: "fixture", description: Object.hasOwn(schema, "default") ? "One schema-valid non-default representative value" : "One schema-valid representative value" });
    }
  }
  if (Object.hasOwn(schema, "default") && !choices.some((choice) => choice.kind === "literal" && JSON.stringify(choice.value) === JSON.stringify(schema.default))) {
    choices.push({ kind: "literal", value: schema.default, defaultValue: true });
  }
  return choices;
}

export function combinationCount(factors) {
  return factors.reduce((count, factor) => count * BigInt(factor.choices.length), 1n).toString();
}

export function* combinations(factors, index = 0, selection = {}) {
  if (index === factors.length) { yield selection; return; }
  const factor = factors[index];
  for (const choice of factor.choices) {
    yield* combinations(factors, index + 1, { ...selection, [factor.field]: choice });
  }
}

export function topLevelBodyFactors(document, rawSchema) {
  const schema = resolveReference(document, rawSchema) ?? {};
  if (schema.readOnly) add("client-supplied-server-owned-field", "check-runtime");
  return Object.entries(schema.properties ?? {}).map(([field, value]) => ({
    field,
    required: (schema.required ?? []).includes(field),
    choices: choicesFor(document, value, (schema.required ?? []).includes(field)),
  }));
}

export function collectSchemaCases(document, rawSchema, field, required = true, when = [], ancestors = []) {
  const records = [];
  const add = (variant, expectedForNode, detail = {}) => {
    records.push({ field, when, variant, expectedForNode, ...detail });
  };
  if (rawSchema?.$ref && ancestors.includes(rawSchema.$ref)) {
    add("recursive-schema", "fixture-required", { schemaRef: rawSchema.$ref });
    return records;
  }
  const nextAncestors = rawSchema?.$ref ? [...ancestors, rawSchema.$ref] : ancestors;
  const schema = resolveReference(document, rawSchema) ?? {};
  if (!required) add("omitted", "accept");
  else add("omitted", "reject");
  const types = schemaTypes(schema);
  const nullable = schema.enum ? schema.enum.includes(null)
    : Object.hasOwn(schema, "const") ? schema.const === null : types.includes("null");
  add("null", nullable ? "accept" : (types.length || schema.enum || Object.hasOwn(schema, "const") ? "reject" : "check-schema"));
  if (types.length || schema.enum || Object.hasOwn(schema, "const")) {
    add("wrong-json-type", "reject", { acceptedTypes: types });
  }
  if (schema.enum) {
    schema.enum.forEach((value) => add("enum-value", "accept", { value }));
    add("unknown-enum-value", "reject");
  }
  if (Object.hasOwn(schema, "const")) {
    add("constant", "accept", { value: schema.const });
    add("different-constant", "reject");
  }
  if (types.includes("boolean")) {
    add("false", schema.enum && !schema.enum.includes(false) ? "reject" : "check-schema", { value: false });
    add("true", schema.enum && !schema.enum.includes(true) ? "reject" : "check-schema", { value: true });
    add("boolean-as-string", "reject");
  }
  if (types.includes("integer") || types.includes("number")) {
    add("ordinary-number", "fixture-required");
    add("numeric-string", "reject");
    if (types.includes("integer")) add("fractional-number", "reject");
    add("zero", "check-schema", { value: 0 });
    add("negative-number", "check-schema");
    for (const bound of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
      if (typeof schema[bound] !== "number") continue;
      const lower = bound.toLowerCase().includes("minimum");
      add(`at-${bound}`, bound.startsWith("exclusive") ? "reject" : "check-schema", { value: schema[bound] });
      add(`inside-${bound}`, "check-schema", { boundary: schema[bound], direction: lower ? "above" : "below" });
      add(`outside-${bound}`, "reject", { boundary: schema[bound], direction: lower ? "below" : "above" });
    }
    if (schema.multipleOf !== undefined) {
      add("multiple-of", "check-schema", { multipleOf: schema.multipleOf });
      add("not-multiple-of", "reject", { multipleOf: schema.multipleOf });
    }
    add("non-finite-number-on-wire", "wire-format-test", { description: "NaN/Infinity cannot be JSON numbers; send malformed JSON and strings separately." });
  }
  if (types.includes("string")) {
    add("ordinary-string", "fixture-required");
    add("empty-string", schema.minLength > 0 ? "reject" : "check-schema", { value: "" });
    add("whitespace-only", "check-runtime");
    add("unicode-and-escaped-text", "check-runtime");
    for (const bound of ["minLength", "maxLength"]) {
      if (schema[bound] === undefined) continue;
      add(`at-${bound}`, "check-schema", { length: schema[bound] });
      if (bound === "maxLength" || schema[bound] > 0) {
        add(`outside-${bound}`, "reject", { length: schema[bound] + (bound === "minLength" ? -1 : 1) });
      }
    }
    if (schema.pattern) {
      add("matching-pattern", "check-schema", { pattern: schema.pattern });
      add("non-matching-pattern", "reject", { pattern: schema.pattern });
    }
    if (schema.format) {
      add("valid-format", "check-runtime", { format: schema.format });
      add("invalid-format", "check-runtime", { format: schema.format });
      if (schema.format === "date-time") add("equivalent-timezone-offset", "check-runtime");
    }
  }
  if (types.includes("array") || schema.items) {
    add("empty-array", schema.minItems > 0 ? "reject" : "check-schema", { length: 0 });
    add("single-item", "check-schema", { length: 1 });
    add("multiple-items", "check-schema");
    add("mixed-valid-invalid-items", "check-runtime", { description: "Check rejection/partial acceptance and atomicity against the route implementation." });
    if (schema.uniqueItems) add("duplicate-items", "reject");
    else add("duplicate-items", "check-runtime");
    for (const bound of ["minItems", "maxItems"]) {
      if (schema[bound] === undefined) continue;
      add(`at-${bound}`, "check-schema", { length: schema[bound] });
      if (bound === "maxItems" || schema[bound] > 0) {
        add(`outside-${bound}`, "reject", { length: schema[bound] + (bound === "minItems" ? -1 : 1) });
      }
    }
    if (schema.items) records.push(...collectSchemaCases(document, schema.items, `${field}[]`, true, [...when, `${field} has an item`], nextAncestors));
  }
  if (types.includes("object") || schema.properties || schema.required || schema.additionalProperties) {
    add("empty-object", "check-schema");
    add("unknown-property", schema.additionalProperties === false ? "reject" : "check-runtime");
    for (const bound of ["minProperties", "maxProperties"]) {
      if (schema[bound] === undefined) continue;
      add(`at-${bound}`, "check-schema", { propertyCount: schema[bound] });
      if (bound === "maxProperties" || schema[bound] > 0) add(`outside-${bound}`, "reject", { propertyCount: schema[bound] + (bound === "minProperties" ? -1 : 1) });
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      const childRequired = (schema.required ?? []).includes(name);
      records.push(...collectSchemaCases(document, child, `${field}.${name}`, childRequired, [...when, `${field} is an object`], nextAncestors));
    }
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(schema.properties ?? {}, name)) {
        records.push({ field: `${field}.${name}`, when: [...when, `${field} is an object`], variant: "required-property-omitted", expectedForNode: "reject" });
      }
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      records.push(...collectSchemaCases(document, schema.additionalProperties, `${field}.{key}`, true, [...when, `${field} has a map entry`], nextAncestors));
    }
  }
  for (const union of ["oneOf", "anyOf", "allOf"]) {
    if (!schema[union]) continue;
    add(`satisfy-${union}`, "check-schema", { branchCount: schema[union].length });
    if (union === "oneOf") add("satisfy-multiple-oneOf-branches", "reject");
    if (union !== "allOf") add(`satisfy-no-${union}-branch`, "reject");
    schema[union].forEach((branch, index) => {
      records.push(...collectSchemaCases(document, branch, field, true, [...when, `${field} ${union}[${index}]`], nextAncestors));
    });
  }
  if (schema.not) add("satisfy-forbidden-schema", "reject");
  return records;
}
