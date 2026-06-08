import type { Request, Response } from "express";
import type { GatewayRpc } from "../gateway/rpc.js";
import { SSEManager } from "./sse-manager.js";
import type { AttachmentStorage } from "./attachment-storage.js";

/**
 * Chat Controller — handles message sending, aborting, and SSE streaming.
 *
 * Uses chat.send RPC to deliver message to the specified session.
 * Since Gateway does not push chat events to proxy clients,
 * we poll chat.history after send to detect new messages and push via SSE.
 */
export class ChatController {
  constructor(
    private rpc: GatewayRpc,
    private sseManager: SSEManager,
    private attachmentStorage?: AttachmentStorage,
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

    // Save attachments before forwarding
    if (this.attachmentStorage && attachments && Array.isArray(attachments)) {
      void this.attachmentStorage.saveAttachments(sessionKey, attachments as any[], message);
    }

    // Get current history snapshot to compare later
    const historyBefore = await this.getHistorySnapshot(sessionKey);

    // chat.send to deliver message
    const rpcPromise = this.rpc.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey,
      ...(attachments ? { attachments } : {}),
    });

    // Wait for the RPC response (generous timeout for agent turns)
    const timeoutMs = 120_000;
    const timer = setTimeout(() => {}, timeoutMs);

    try {
      const result = await Promise.race([
        rpcPromise,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);

      clearTimeout(timer);

      const payload = result as Record<string, unknown> | null;
      const newSessionKey =
        (payload?.sessionKey as string) ??
        (payload?.canonicalKey as string) ??
        null;

      // Start polling for new messages in background
      this.pollForNewMessages(sessionKey, historyBefore, idempotencyKey);

      res.json({
        success: true,
        idempotencyKey,
        ...(newSessionKey && newSessionKey !== sessionKey ? { newSessionKey } : {}),
      });
    } catch (err) {
      clearTimeout(timer);
      console.error(
        `[ChatController] chat.send RPC: ${err instanceof Error ? err.message : String(err)}`,
      );

      // Still start polling — message may have been accepted
      this.pollForNewMessages(sessionKey, historyBefore, idempotencyKey);

      res.json({
        success: true,
        idempotencyKey,
      });
    }
  }

  /**
   * GET /api/chat/history?session=xxx
   */
  async history(req: Request, res: Response): Promise<void> {
    const sessionKey = (req.query.session ?? req.query.sessionKey) as string | undefined;

    if (!sessionKey) {
      res.status(400).json({ error: "Missing query parameter: session" });
      return;
    }

    try {
      const result = await this.rpc.request("chat.history", {
        sessionKey,
        limit: 100,
      }) as { messages?: Array<Record<string, unknown>> };
      res.json({ success: true, messages: result?.messages ?? [] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  }

  /**
   * POST /api/chat/abort
   */
  async abort(req: Request, res: Response): Promise<void> {
    const { sessionKey, runId } = req.body as {
      sessionKey?: string;
      runId?: string;
    };

    if (!sessionKey) {
      res.status(400).json({ success: false, error: "Missing required field: sessionKey" });
      return;
    }

    try {
      const params: Record<string, unknown> = { sessionKey };
      if (runId) params.runId = runId;
      await this.rpc.request("chat.abort", params);
      res.json({ success: true, aborted: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ success: false, error: msg });
    }
  }

  /**
   * GET /api/chat/stream?session=xxx
   * SSE connection for real-time message streaming.
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

  // ── Private helpers ──

  private async getHistorySnapshot(sessionKey: string): Promise<number> {
    try {
      const result = await this.rpc.request("chat.history", {
        sessionKey,
        limit: 1,
      }) as { messages?: Array<unknown> };
      return result?.messages?.length ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Poll chat.history until a new message appears, then push via SSE.
   * Runs for up to 2 minutes (matching agent turn timeout).
   */
  private pollForNewMessages(
    sessionKey: string,
    messageCountBefore: number,
    runId: string,
  ): void {
    let attempts = 0;
    const maxAttempts = 60; // 60 * 2s = 120s
    const pollInterval = 2000;

    const timer = setInterval(async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearInterval(timer);
        return;
      }

      try {
        const result = await this.rpc.request("chat.history", {
          sessionKey,
          limit: 5,
        }) as { messages?: Array<Record<string, unknown>> };

        const messages = result?.messages ?? [];
        if (messages.length > messageCountBefore) {
          // Find new messages (those not in the original snapshot)
          for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            const role = String(msg.role ?? "assistant");
            const rawContent = msg.content;
            const content = typeof rawContent === "string"
              ? rawContent
              : (Array.isArray(rawContent)
                  ? rawContent
                      .filter((c: any) => c.type === "text" || c.type === "toolResult")
                      .map((c: any) => c.text ?? "")
                      .join("")
                  : String(rawContent ?? ""));
            const timestamp = String(msg.timestamp ?? new Date().toISOString());

            this.sseManager.broadcast(sessionKey, "message", {
              role,
              content,
              timestamp,
              messageId: String(msg.id ?? runId),
              state: "final",
            });

            // Only push the latest new message
            if (messages.length - messageCountBefore >= 1) break;
          }
          clearInterval(timer);
        }
      } catch {
        // Ignore poll errors, keep trying
      }
    }, pollInterval);

    // Don't block — let the interval clean up on its own
  }
}
