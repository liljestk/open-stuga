import { ResponseShapeError } from "@climate-twin/contracts";

/**
 * Parses one response body at the client boundary: returns it typed or throws a ResponseShapeError
 * naming the endpoint. Every request names the shape it expects; hooks and components only ever see
 * values a shape has accepted.
 */
export type ResponseShape<T> = (value: unknown, endpoint: string) => T;

/** The type a shape accepts. */
export type ShapeOf<S> = S extends ResponseShape<infer T> ? T : never;

/** The JSON kind of a field; `|null` admits null as well. */
export type JsonKind = "string" | "number" | "boolean" | "array" | "object";
type FieldKind = JsonKind | `${JsonKind}|null`;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKind(value: unknown, kind: JsonKind): boolean {
  if (kind === "array") return Array.isArray(value);
  if (kind === "object") return isRecord(value);
  return typeof value === kind;
}

function matchesKind(value: unknown, kind: FieldKind): boolean {
  const [base, nullable] = kind.split("|") as [JsonKind, "null" | undefined];
  return (nullable === "null" && value === null) || hasKind(value, base);
}

/** A body the caller validates itself, field by field, after the request. */
export const anyBody: ResponseShape<unknown> = (value) => value;

/** A 204 response, or any body the caller ignores. */
export const noContent: ResponseShape<void> = () => undefined;

export const string: ResponseShape<string> = (value, endpoint) => {
  if (typeof value !== "string") throw new ResponseShapeError(endpoint, "expected a string");
  return value;
};

export const number: ResponseShape<number> = (value, endpoint) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ResponseShapeError(endpoint, "expected a number");
  return value;
};

export const boolean: ResponseShape<boolean> = (value, endpoint) => {
  if (typeof value !== "boolean") throw new ResponseShapeError(endpoint, "expected a boolean");
  return value;
};

/** Exactly `expected`. */
export function literal<const T extends string | number | boolean>(expected: T): ResponseShape<T> {
  return (value, endpoint) => {
    if (value !== expected) throw new ResponseShapeError(endpoint, `expected ${String(expected)}`);
    return expected;
  };
}

export function nullable<T>(inner: ResponseShape<T>): ResponseShape<T | null> {
  return (value, endpoint) => (value === null ? null : inner(value, endpoint));
}

/** A field the body may omit. */
export function optional<T>(inner: ResponseShape<T>): ResponseShape<T | undefined> {
  return (value, endpoint) => (value === undefined ? undefined : inner(value, endpoint));
}

export function arrayOf<T>(inner: ResponseShape<T>): ResponseShape<T[]> {
  return (value, endpoint) => {
    if (!Array.isArray(value)) throw new ResponseShapeError(endpoint, "expected an array");
    return value.map((item) => inner(item, endpoint));
  };
}

export function recordOf<T>(inner: ResponseShape<T>): ResponseShape<Record<string, T>> {
  return (value, endpoint) => {
    if (!isRecord(value)) throw new ResponseShapeError(endpoint, "expected an object");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inner(item, endpoint)]));
  };
}

type FieldShapes = Record<string, ResponseShape<unknown>>;
type OptionalKeys<S extends FieldShapes> = { [K in keyof S]: undefined extends ShapeOf<S[K]> ? K : never }[keyof S];
type FieldsOf<S extends FieldShapes> = { [K in Exclude<keyof S, OptionalKeys<S>>]: ShapeOf<S[K]> }
  & { [K in OptionalKeys<S>]?: Exclude<ShapeOf<S[K]>, undefined> };

/** An envelope object: each listed field is parsed by its shape; a field whose shape is optional may be absent. */
export function fields<S extends FieldShapes>(shapes: S): ResponseShape<FieldsOf<S>> {
  return (value, endpoint) => {
    if (!isRecord(value)) throw new ResponseShapeError(endpoint, "expected an object");
    const parsed: Record<string, unknown> = {};
    for (const [key, shape] of Object.entries(shapes)) {
      const field = shape(value[key], endpoint);
      if (field !== undefined) parsed[key] = field;
    }
    return parsed as FieldsOf<S>;
  };
}

/** Adapts a contracts `is…` guard. */
export function guarded<T>(guard: (value: unknown) => value is T): ResponseShape<T> {
  return (value, endpoint) => {
    if (!guard(value)) throw new ResponseShapeError(endpoint);
    return value;
  };
}

/**
 * An entity object whose listed fields have the listed JSON kinds. The descriptor names fields of `T`,
 * so a field the type drops fails to compile; nested values are left to the entity's own consumers.
 */
export function entity<T extends object>(name: string, kinds: { readonly [K in keyof T]?: FieldKind }): ResponseShape<T> {
  return (value, endpoint) => {
    if (!isRecord(value)) throw new ResponseShapeError(endpoint, `expected a ${name}`);
    for (const [key, kind] of Object.entries(kinds) as [string, FieldKind][]) {
      if (!matchesKind(value[key], kind)) throw new ResponseShapeError(endpoint, `${name}.${key} is not a ${kind}`);
    }
    return value as T;
  };
}
