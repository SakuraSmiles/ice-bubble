import type { Request, Response } from "express";
import type { GatewayRpc } from "../gateway/rpc.js";
import { SSEManager } from "./sse-manager.js";

/**
 * Chat Controller — handles message sending, aborting, and SSE streaming.
 */
export class ChatController {
  constructor(
    private rpc: GatewayRpc,
    private sseManager: SSEManager,
  ) {}

  /**
   * POST /api/chat/send
   * Body: { sessionKey, message }
   */
  async send(req: Request, res: Response): Promise<void> {
    const { sessionKey, message } = req.body as {
      sessionKey?: string;
      message?: string;
    };

    if (!sessionKey || !message) {
      res.status(400).json({
        success: false,
        error: "Missing required fields: sessionKey, message",
      });
      return;
    }

    const idempotencyKey = crypto.randomUUID();

    if (!this.rpc.isConnected()) {
      res.status(503).json({
        success: false,
        error: "Gateway not connected",
      });
      return;
    }

    // Fire-and-forget: send the RPC request but respond immediately.
    // The Gateway's chat.send handler is async and waits for the agent turn,
    // which can take much longer than a reasonable HTTP timeout.
    // Message delivery is confirmed via SSE stream events (chat.delta/chat.final).
    const rpcPromise = this.rpc.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey,
    });

    // Log errors from the RPC for debugging, but don't block the HTTP response.
    rpcPromise.catch((err) => {
      // RPC errors are logged but don't affect the HTTP response.
      // The SSE stream will surface agent errors to the frontend.
      console.error(`[ChatController] chat.send RPC failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    res.json({
      success: true,
      idempotencyKey,
    });
  }

  /**
   * POST /api/chat/abort
   * Body: { sessionKey }
   */
  async abort(req: Request, res: Response): Promise<void> {
    const { sessionKey, runId } = req.body as {
      sessionKey?: string;
      runId?: string;
    };

    if (!sessionKey) {
      res.status(400).json({
        success: false,
        error: "Missing required field: sessionKey",
      });
      return;
    }

    try {
      const params: Record<string, unknown> = { sessionKey };
      if (runId) params.runId = runId;
      await this.rpc.request("chat.abort", params);
      res.json({ success: true, aborted: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ success: false, error: message });
    }
  }

  /**
   * GET /api/chat/stream?session=xxx
   * Establishes an SSE connection for real-time message streaming.
   */
  stream(req: Request, res: Response): void {
    const sessionKey = req.query.session as string | undefined;

    if (!sessionKey) {
      res.status(400).json({ error: "Missing query parameter: session" });
      return;
    }

    this.sseManager.addClient(sessionKey, res);

    // Send initial connection status
    this.sseManager.broadcast(sessionKey, "status", { connected: true });

    // Clean up on client disconnect
    req.on("close", () => {
      this.sseManager.removeClient(sessionKey, res);
    });
  }
}
