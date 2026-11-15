export type Schema<T = unknown> = (
  value: unknown,
  opts?: { logFailures?: boolean }
) => value is T;
export type OptionalSchema<T = unknown> = Schema<T | undefined> & {
  readonly __optional: true;
};
export type TypeOf<T> = T extends Schema<infer U> ? U : never;

export type UnwrapSchemaMap<T> = {
  [K in keyof T]: T[K] extends Schema<infer U> ? U : never;
};

type OptionalKeys<T extends Record<string, Schema>> = {
  [K in keyof T]: T[K] extends OptionalSchema ? K : never;
}[keyof T];

type RequiredKeys<T extends Record<string, Schema>> = Exclude<
  keyof T,
  OptionalKeys<T>
>;

type ShapeType<T extends Record<string, Schema>> = {
  [K in RequiredKeys<T>]: TypeOf<T[K]>;
} & {
  [K in OptionalKeys<T>]?: Exclude<TypeOf<T[K]>, undefined>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const string: Schema<string> = (value): value is string =>
  typeof value === 'string';

export const number: Schema<number> = (value): value is number =>
  typeof value === 'number' && !Number.isNaN(value);

export const boolean: Schema<boolean> = (value): value is boolean =>
  typeof value === 'boolean';

export function literal<T extends string | number | boolean | null>(
  expected: T
): Schema<T> {
  return (value): value is T => value === expected;
}

export function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  const optionalSchema = ((value: unknown): value is T | undefined =>
    value === undefined || schema(value)) as OptionalSchema<T>;
  Object.defineProperty(optionalSchema, '__optional', { value: true });
  return optionalSchema;
}

export function array<T>(schema: Schema<T>): Schema<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && value.every((item) => schema(item));
}

export function tuple<T extends readonly Schema[]>(
  schemas: T
): Schema<{ [K in keyof T]: TypeOf<T[K]> }> {
  return (value): value is { [K in keyof T]: TypeOf<T[K]> } =>
    Array.isArray(value) &&
    value.length === schemas.length &&
    schemas.every((schema, index) => schema(value[index]));
}

export function shape<T extends Record<string, Schema>>(
  schemas: T
): Schema<ShapeType<T>> {
  return (value): value is ShapeType<T> =>
    isObject(value) &&
    Object.entries(schemas).every(([key, schema]) => schema(value[key]));
}

export function unionMany<T extends readonly Schema[]>(
  schemas: T
): Schema<TypeOf<T[number]>> {
  return (value): value is TypeOf<T[number]> =>
    schemas.some((schema) => schema(value));
}

export function intersection<A, B>(
  schemaA: Schema<A>,
  schemaB: Schema<B>
): Schema<A & B> {
  return (value): value is A & B => schemaA(value) && schemaB(value);
}

export function taggedUnion<
  K extends string,
  T extends Record<string, Record<string, Schema>>
>(
  tag: K,
  variants: T
): Schema<
  {
    [V in keyof T]: ShapeType<T[V]>;
  }[keyof T]
> {
  type Result = {
    [V in keyof T]: ShapeType<T[V]>;
  }[keyof T];

  return (value): value is Result => {
    if (!isObject(value)) {
      return false;
    }
    const tagValue = value[tag];
    if (typeof tagValue !== 'string') {
      return false;
    }
    const variant = variants[tagValue];
    if (!variant) {
      return false;
    }
    return shape(variant)(value);
  };
}
