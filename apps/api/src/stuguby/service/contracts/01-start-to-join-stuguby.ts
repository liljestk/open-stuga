import {
  type StugubyRole,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import {
  type StugubyLocalInvitation,
} from "../../store.js";
import "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    start(): void;
    stop(): Promise<void>;
    trackSync<T>(operation: Promise<T>): Promise<T>;
    listStugubys(): StugubySummary[];
    getStuguby(id: string): StugubySummary;
    configurePublicOrigin(value: string): Promise<string>;
    verifyPublicOrigin(publicOrigin: string): Promise<void>;
    deleteStuguby(id: string): void;
    createStuguby(input: {
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }): StugubySummary;
    createInvitation(stugubyId: string, input: {
            role: Exclude<StugubyRole, "steward">;
            expiresAt?: string;
            localLabel?: unknown;
        }): StugubyLocalInvitation & {
            joinSecret: string;
            joinUrl: string;
        };
    revokeInvitation(stugubyId: string, invitationId: string): void;
    assertGrantScope(stugubyId: string, grantId: string): void;
    joinStuguby(input: {
            coordinatorUrl: string;
            invitationId: string;
            joinSecret: string;
        }): Promise<StugubySummary>;
  }

  interface StugubyServiceCore {
    start(): void;
    stop(): Promise<void>;
    listStugubys(): StugubySummary[];
    getStuguby(id: string): StugubySummary;
    configurePublicOrigin(value: string): Promise<string>;
    deleteStuguby(id: string): void;
    createStuguby(input: {
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }): StugubySummary;
    createInvitation(stugubyId: string, input: {
            role: Exclude<StugubyRole, "steward">;
            expiresAt?: string;
            localLabel?: unknown;
        }): StugubyLocalInvitation & {
            joinSecret: string;
            joinUrl: string;
        };
    revokeInvitation(stugubyId: string, invitationId: string): void;
    assertGrantScope(stugubyId: string, grantId: string): void;
    joinStuguby(input: {
            coordinatorUrl: string;
            invitationId: string;
            joinSecret: string;
        }): Promise<StugubySummary>;
  }
}
