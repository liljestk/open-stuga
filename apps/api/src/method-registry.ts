type AnyMethod = (...args: never[]) => unknown;

export type MethodsOf<T> = {
  [Name in keyof T as T[Name] extends AnyMethod ? Name : never]: T[Name];
};

export type RegisteredMethodSet<TInternals> =
  Partial<MethodsOf<TInternals>>
  & ThisType<TInternals>;

export type IncompatibleMethodKeys<TPublic, TInternals> = {
  [Name in keyof MethodsOf<TPublic>]:
    Name extends keyof MethodsOf<TInternals>
      ? MethodsOf<TInternals>[Name] extends MethodsOf<TPublic>[Name]
        ? never
        : Name
      : Name;
}[keyof MethodsOf<TPublic>];

export type AssertNoMethodKeys<Keys extends never> = Keys;

export function installRegisteredMethods(
  owner: string,
  prototype: object,
  methods: object,
): void {
  for (const [name, method] of Object.entries(methods)) {
    if (typeof method !== "function") {
      throw new TypeError(`${owner}.${name} must be registered as a function`);
    }
    if (Object.prototype.hasOwnProperty.call(prototype, name)) {
      throw new Error(`${owner}.${name} was registered more than once`);
    }
    Object.defineProperty(prototype, name, {
      value: method,
      // Test fault injection and observability tooling need to wrap methods.
      // Duplicate registration is still rejected before this point.
      configurable: true,
      writable: false,
      enumerable: false,
    });
  }
}
