import { readFileSync } from "node:fs";
import type { MqttClient } from "mqtt";
import type { SourceTransport, SourceTransportState } from "./source-transport.js";

export interface MqttSourceTransportConfig {
  host: string;
  port: number;
  username: string;
  passwordFile: string;
  topic: string;
}

export class MqttSourceTransport implements SourceTransport {
  private client: MqttClient | null = null;

  constructor(private readonly config: MqttSourceTransportConfig) {}

  async start(
    onMessage: (message: { topic: string; payload: Buffer; retained: boolean }) => void,
    onState: (state: SourceTransportState, detail?: string) => void,
  ): Promise<void> {
    if (this.client) return;
    const password = readFileSync(this.config.passwordFile, "utf8").trim();
    if (!/^[0-9a-f]{64}$/u.test(password)) throw new Error("MQTT subscriber credential is unavailable");
    onState("starting");
    const { connect } = await import("mqtt");
    const client = connect(`mqtt://${this.config.host}:${this.config.port}`, {
      username: this.config.username,
      password,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
      resubscribe: true,
    });
    this.client = client;
    client.on("connect", () => {
      client.subscribe(this.config.topic, { qos: 0 }, (error) => {
        if (error) onState("error", "The MQTT subscription could not be established");
        else onState("connected");
      });
    });
    client.on("reconnect", () => onState("starting"));
    client.on("offline", () => onState("disconnected"));
    client.on("close", () => onState("disconnected"));
    client.on("error", () => onState("error", "The local MQTT connection failed"));
    client.on("message", (topic, payload, packet) => onMessage({
      topic,
      payload: Buffer.from(payload),
      retained: packet.retain,
    }));
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
  }
}
