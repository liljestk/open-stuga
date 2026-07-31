export interface SourceTransportMessage {
  topic: string;
  payload: Buffer;
  retained: boolean;
}

export type SourceTransportState = "starting" | "connected" | "disconnected" | "error";

export interface SourceTransport {
  start(
    onMessage: (message: SourceTransportMessage) => void,
    onState: (state: SourceTransportState, detail?: string) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}
