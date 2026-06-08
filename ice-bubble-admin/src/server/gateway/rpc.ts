import type { GatewayProxy } from "../../gateway/gateway-proxy.js";

export class GatewayRpc {
  private proxy: GatewayProxy;
  private subscriptions = new Map<string, Set<(result: unknown) => void>>();
  private subMethodToId = new Map<string, string>();

  isConnected(): boolean {
    return this.proxy.isConnected;
  }

  getProxy(): GatewayProxy {
    return this.proxy;
  }

  constructor(proxy: GatewayProxy) {
    this.proxy = proxy;

    this.proxy.on("session.message", (payload) => {
      this.handleNotification("session.message", payload);
    });

    this.proxy.on("sessions.messages.subscribe", (payload) => {
      this.handleNotification("sessions.messages.subscribe", payload);
    });

    this.proxy.on("disconnected", () => {});
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proxy.isConnected) {
      return Promise.reject(new Error("Gateway not connected"));
    }
    return this.proxy.request(method, params);
  }

  subscribe(
    method: string,
    params: Record<string, unknown>,
    handler: (result: unknown) => void,
  ): () => void {
    const subId = `${method}:${JSON.stringify(params)}`;
    if (!this.subscriptions.has(subId)) {
      this.subscriptions.set(subId, new Set());
      this.subMethodToId.set(method, subId);
    }
    this.subscriptions.get(subId)!.add(handler);
    this.request(method, params).catch(() => {});
    return () => {
      const handlers = this.subscriptions.get(subId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(subId);
          this.subMethodToId.delete(method);
        }
      }
    };
  }

  private static readonly EVENT_TO_SUB = new Map([
    ["session.message", "sessions.messages.subscribe"],
  ]);

  private handleNotification(event: string, payload: unknown): void {
    const mappedKey = GatewayRpc.EVENT_TO_SUB.get(event) ?? event;
    for (const [subId, handlers] of this.subscriptions) {
      if (subId.startsWith(mappedKey)) {
        for (const h of handlers) {
          try { h(payload); } catch {}
        }
      }
    }
  }
}
