import type { Request, Response } from "express";
import type { GatewayRpc } from "../gateway/rpc.js";
import { SSEManager } from "./sse-manager.js";

/**
 * Chat Controller — handles message sending, aborting, and SSE streaming.
 *
 * Uses `sessions.send` RPC to correctly target the specified session.
 * For active sessions, the message is delivered and agent turn starts.
 * For completed subagent sessions, the Gateway may create a new session;
 * the new sessionKey is returned so the frontend can follow it.
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
    const { sessionKey, message, attachments } = req.body as {
      sessionKey?: string;
      message?: string;
      attachments?: unknown[];
    };

    if (!sessionKey || !message) {
      res.status(400).json({
        success: false,
        error: "Missing required fields: sessionKey, message",
      });
      return;
    }

    if (!this.rpc.isConnected()) {
      res.status(503).json({
        success: false,
        error: "Gateway not connected",
      });
      return;
    }

    const idempotencyKey = crypto.randomUUID();

    // Use sessions.send to target the exact session.
    // sessions.send only accepts: key, message, idempotencyKey (no label).
    const rpcPromise = this.rpc.request("sessions.send", {
      key: sessionKey,
      message,
      idempotencyKey,
      ...(attachments ? { attachments } : {}),
    });

    // Wait for the RPC response with a generous timeout (agent turns can be long).
    // The SSE stream handles streaming updates; this is for the initial acknowledgment.
    const timeoutMs = 120_000; // 2 minutes
    const timer = setTimeout(() => {
      // Timed out but message may still be processing — tell client it was accepted
    }, timeoutMs);

    try {
      const result = await Promise.race([
        rpcPromise,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);

      clearTimeout(timer);

      const payload = result as Record<string, unknown> | null;

      // Gateway sessions.send may return a new session key if it created a continuation
      const newSessionKey =
        (payload?.sessionKey as string) ??
        (payload?.canonicalKey as string) ??
        null;

      res.json({
        success: true,
        idempotencyKey,
        ...(newSessionKey && newSessionKey !== sessionKey ? { newSessionKey } : {}),
      });
    } catch (err) {
      clearTimeout(timer);

      // RPC error or timeout — message may still be processing
      // Tell client it was accepted so SSE can pick up updates
      console.error(
        `[ChatController] sessions.send RPC: ${err instanceof Error ? err.message : String(err)}`,
      );

      res.json({
        success: true,
        idempotencyKey,
      });
    }
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
