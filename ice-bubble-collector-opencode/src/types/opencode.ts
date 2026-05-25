/**
 * OpenCode 原始数据类型声明
 * 
 * 对应 opencode.db 的表结构，来源于 opencode-data-structure.md
 */

// ==================== Project ====================

export interface OpenCodeProject {
    id: string;
    worktree: string;
    vcs: string | null;
    name: string | null;
    icon_url: string | null;
    icon_color: string | null;
    time_created: number;
    time_updated: number;
    time_initialized: number | null;
    sandboxes: string;
    commands: string | null;
    icon_url_override: string | null;
}

// ==================== Session ====================

export interface OpenCodeSession {
    id: string;                     // 格式: ses_<32 hex chars>
    project_id: string;
    parent_id: string | null;
    slug: string;
    directory: string;
    title: string;
    version: string;
    share_url: string | null;
    summary_additions: number | null;
    summary_deletions: number | null;
    summary_files: number | null;
    summary_diffs: string | null;   // JSON
    revert: string | null;          // JSON
    permission: string | null;      // JSON
    time_created: number;           // ms timestamp
    time_updated: number;
    time_compacting: number | null;
    time_archived: number | null;
    workspace_id: string | null;
    path: string | null;
    agent: string | null;
    model: string | null;
    /** JOIN from project table */
    project_name?: string | null;
    project_worktree?: string | null;
}

// ==================== Message ====================

export interface OpenCodeMessage {
    id: string;                     // 格式: msg_<24 hex chars>
    session_id: string;
    time_created: number;           // ms timestamp
    time_updated: number;
    data: string;                   // JSON: UserMessageData | AssistantMessageData
}

// ==================== Message data JSON ====================

export interface UserMessageData {
    role: 'user';
    time: {
        created: number;
    };
    summary?: {
        diffs: unknown[];
    };
    agent?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
}

export interface AssistantMessageData {
    role: 'assistant';
    parentID?: string;
    mode: string;
    agent?: string;
    path?: {
        cwd: string;
        root: string;
    };
    cost?: number;
    tokens?: TokenInfo;
    modelID?: string;
    providerID?: string;
    time: {
        created: number;
        completed?: number;
    };
    finish?: string;
    error?: unknown;
    summary?: boolean;
}

export type MessageData = UserMessageData | AssistantMessageData;

// ==================== Token Info ====================

export interface TokenInfo {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cache?: {
        write: number;
        read: number;
    };
}

// ==================== Part ====================

export interface OpenCodePart {
    id: string;                     // 格式: prt_<24 hex chars>
    message_id: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;                   // JSON: TextPartData | ToolPartData | ...
}

// ==================== Part data types ====================

export type PartData =
    | TextPartData
    | ToolPartData
    | ReasoningPartData
    | StepStartPartData
    | StepFinishPartData
    | CompactionPartData
    | PatchPartData;

export interface TextPartData {
    type: 'text';
    text: string;
    time?: {
        start: number;
        end: number;
    };
}

export interface ToolPartData {
    type: 'tool';
    callID: string;
    tool: string;
    state: ToolState;
}

export interface ToolState {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: {
        output?: string;
        exit?: number;
        description?: string;
        truncated?: boolean;
        diff?: string;
        filediff?: unknown;
        sessionId?: string;
        model?: { modelID: string; providerID: string };
        answers?: unknown[];
    };
    time?: {
        start: number;
        end: number;
    };
}

export interface ReasoningPartData {
    type: 'reasoning';
    text: string;
    metadata?: {
        anthropic?: {
            signature: string;
        };
    };
    time?: {
        start: number;
        end: number;
    };
}

export interface StepStartPartData {
    type: 'step-start';
    snapshot?: unknown;
}

export interface StepFinishPartData {
    type: 'step-finish';
    reason?: string;
    cost?: number;
    tokens?: TokenInfo;
}

export interface CompactionPartData {
    type: 'compaction';
    auto?: boolean;
}

export interface PatchPartData {
    type: 'patch';
    hash: string;
    files: string[];
}

// ==================== Session + Project join result ====================

export interface SessionWithProject extends OpenCodeSession {
    project_name: string | null;
    project_worktree: string | null;
}

// ==================== Message with parts (query result) ====================

export interface MessageWithParts {
    message: OpenCodeMessage;
    parts: OpenCodePart[];
}
