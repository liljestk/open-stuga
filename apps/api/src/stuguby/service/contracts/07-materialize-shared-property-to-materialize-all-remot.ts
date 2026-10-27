import {
  type StugubySharedProperty,
} from "@climate-twin/stuguby-protocol";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    materializeSharedProperty(shared: StugubySharedProperty): void;
    materializeAllRemoteHomes(stugubyId: string): void;
  }
}
