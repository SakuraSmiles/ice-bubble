import { request } from './client';

export interface OpenCodeSendRequest {
  agent: 'build';
  message: string;
  sessionId?: string;
}

export interface OpenCodeSendResponse {
  success: boolean;
  sessionId: string;
  content: string;
  tokens?: { total?: number; input?: number; output?: number };
  model?: string;
  agent?: string;
}

export async function sendOpenCodeChat(req: OpenCodeSendRequest): Promise<OpenCodeSendResponse> {
  const res = await request('/opencode/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`OpenCode chat failed: HTTP ${res.status}`);
  return res.json();
}

export async function checkOpenCodeHealth(): Promise<boolean> {
  try {
    const res = await request('/opencode/chat/health');
    const data = await res.json();
    return data.status === 'connected';
  } catch {
    return false;
  }
}
