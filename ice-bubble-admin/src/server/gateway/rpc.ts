import type { GatewayProxy } from "../../gateway/gateway-proxy.js";

export class GatewayRpc {
  private proxy: GatewayProxy;
  private subscriptions = new Map<string, Set<(result: unknown) => void>>();
  private subMethodToId = new Map<string, string>();

  /** Check if the underlying Gateway connection is ready for requests. */
  isConnected(): boolean {
    return this.proxy.isConnected;
  }

  constructor(proxy: GatewayProxy) {
    this.proxy = proxy;

    // Listen for all events from GatewayProxy and route to subscription handlers.
    this.proxy.on("session.message", (payload) => {
      this.handleNotification("session.message", payload);
    });

    // Also catch any event that matches subscription prefixes via a generic listener.
    // GatewayProxy forwards all non-internal events via on().
    // We hook into specific known event names for robustness.
    this.proxy.on("sessions.messages.subscribe", (payload) => {
      this.handleNotification("sessions.messages.subscribe", payload);
    });

    // Reject all pending on disconnect
    this.proxy.on("disconnected", () => {
      // No pending map to reject — proxy.request() handles its own timeouts.
      // Notify SSE clients via subscriptions won't receive events.
    });
  }

  /** Send a Gateway request and wait for the matching response. */
  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proxy.isConnected) {
      return Promise.reject(new Error("Gateway not connected"));
    }

    return this.proxy.request(method, params);
  }

  /**
   * Subscribe to a server-pushed event stream.
   * Returns an unsubscribe function.
   */
  subscribe(
    method: string,
    params: Record<string, unknown>,
    handler: (result: unknown) => void,
  ): () => void {
    const subId = `${method}:${JSON.stringify(params)}`;

    if (!this.subscriptions.has(subId)) {
      this.subscriptions.set(subId, new Set());
      this.subMethodToId.set(method, subId);

      // Listen for events from GatewayProxy and route to subscription handlers.
      // GatewayProxy.on() for these event names will receive pushes.
    }
    this.subscriptions.get(subId)!.add(handler);

    // Send the subscription request
    this.request(method, params).catch(() => {
      // Subscription request failed — handler won't receive events
    });

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

  /**
   * Map Gateway event names to subscription method prefixes.
   * The Gateway sends events like "session.message" but subscriptions
   * are made to methods like "sessions.messages.subscribe".
   */
  private static readonly EVENT_TO_SUB = new Map([
    ["session.message", "sessions.messages.subscribe"],
  ]);

  private handleNotification(event: string, payload: unknown): void {
    // Map event name to subscription method prefix
    const mappedKey = GatewayRpc.EVENT_TO_SUB.get(event) ?? event;
    for (const [subId, handlers] of this.subscriptions) {
      if (subId.startsWith(mappedKey)) {
        for (const h of handlers) {
          try {
            h(payload);
          } catch {
            // Handler error, ignore
          }
        }
      }
    }
  }
}
