export interface ToolCallEntry {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  phase: 'start' | 'end' | 'result' | 'partial' | 'error';
  result?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface TimelineMessage {
  id: string;
  session_key: string;
  agent_id: string;
  agent_name: string | null;
  avatar: string | null;
  message_type: 'user' | 'agent' | 'tool';
  content: string | null;
  clean_content: string | null;
  content_summary: string | null;
  is_cron: boolean;
  is_system_noise: boolean;
  is_system_context?: number | boolean;
  source_channel: string | null;
  model: string | null;
  timestamp: string;
  streamRunId?: string;
  streamState?: 'thinking' | 'streaming' | 'complete' | 'error';
  toolCalls?: ToolCallEntry[];
}

export interface TimelineResponse {
  messages: TimelineMessage[];
  has_more: boolean;
  pagination: {
    oldest: string | null;
    newest: string | null;
    total_in_range: number;
  };
  meta: {
    agents_in_range: string[];
    filter_applied: Record<string, unknown>;
  };
}

export type MsgGroup = {
  type: 'user' | 'agent' | 'date-divider';
  /** For date-divider: the display label like "今天", "昨天", "5月13日" */
  dateLabel?: string;
  agentId: string;
  agentName: string | null;
  avatar: string | null;
  timestamp: string;
  messages: TimelineMessage[];
  toolMsgs: TimelineMessage[];
  hiddenToolCount: number;
};

export interface UseChatDataOptions {
  sessionKey: () => string | undefined;
  onMessagesUpdate?: () => void;
}

export interface UseGatewayStreamOptions {
  sessionKey: () => string | undefined;
  messages: { value: TimelineMessage[] };
  knownIds: Set<string>;
  atBottom: { value: boolean };
  showTypingIndicator: { value: boolean };
  agentAvatar: { value: string | null };
  addMessage: (msg: TimelineMessage) => void;
  newMsgCount: { value: number };
}
