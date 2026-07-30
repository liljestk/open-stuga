import { expect, it } from "vitest";
import { installRegisteredMethods } from "../src/method-registry.js";

it("keeps registered methods read-only and rejects duplicate registration", () => {
  class Example {}

  installRegisteredMethods("Example", Example.prototype, {
    value() {
      return 42;
    },
  });

  const instance = new Example() as Example & { value(): number };
  expect(instance.value()).toBe(42);
  const descriptor = Object.getOwnPropertyDescriptor(Example.prototype, "value");
  expect(descriptor?.configurable).toBe(true);
  expect(descriptor?.writable).toBe(false);
  expect(
    () => installRegisteredMethods("Example", Example.prototype, { value() { return 7; } }),
  ).toThrow(/registered more than once/);
});

it("rejects non-function prototype members", () => {
  class Example {}

  expect(
    () => installRegisteredMethods("Example", Example.prototype, { invalid: 1 }),
  ).toThrow(/must be registered as a function/);
});
