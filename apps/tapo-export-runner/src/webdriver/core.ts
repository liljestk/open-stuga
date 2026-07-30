import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readBoundedResponseText, ResponseLimitError } from "../bounded-response.js";
import { AppiumClientOptions } from "./support/01-max-appium-json-response-bytes-to-abortable-delay.js";

export const appiumClientState = Symbol("AppiumClient.state");

export interface AppiumClientState {
  sessionId: string | undefined;
  activeCapabilitiesFingerprint: string | undefined;
  options: AppiumClientOptions;
}

export function createAppiumClientState(options: AppiumClientOptions): AppiumClientState {
  return {
    sessionId: undefined,
    activeCapabilitiesFingerprint: undefined,
    options,
  };
}

export interface AppiumClientInternals {
  readonly [appiumClientState]: AppiumClientState;
}

type AppiumMethod = (...args: never[]) => unknown;
type AppiumMethods = {
  [Name in keyof AppiumClientInternals as AppiumClientInternals[Name] extends AppiumMethod
    ? Name
    : never]: AppiumClientInternals[Name];
};
export type AppiumClientMethodSet = Partial<AppiumMethods> & ThisType<AppiumClientInternals>;

export class AppiumClientCore {
  readonly [appiumClientState]: AppiumClientState;

  constructor(options: AppiumClientOptions) {
    this[appiumClientState] = createAppiumClientState(options);
  }
}

export function registerAppiumClientMethods(methods: AppiumClientMethodSet): void {
  for (const [name, method] of Object.entries(methods)) {
    if (typeof method !== "function") throw new TypeError(`AppiumClient.${name} must be a function`);
    if (Object.prototype.hasOwnProperty.call(AppiumClientCore.prototype, name)) {
      throw new Error(`AppiumClient.${name} was registered more than once`);
    }
    Object.defineProperty(AppiumClientCore.prototype, name, {
      value: method, configurable: true, writable: false, enumerable: false,
    });
  }
}
