/**
 * SQLiteManager 单元测试
 * 
 * 测试重点：last_message_at 字段是否正确更新
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteManager } from '../../../src/storage/sqlite-manager';
import type { Session, SessionMessage } from '../../../src/types';

describe('SQLiteManager - last_message_at 修复验证', () => {
    let db: SQLiteManager;
    const testDbPath = '/tmp/test-collector-' + Date.now() + '.db';

    beforeEach(async () => {
        db = new SQLiteManager();
        await db.init({
            dbPath: testDbPath,
            walMode: false,
            foreignKeys: true,
        });
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
        // 清理测试数据库
        try {
            const fs = await import('fs');
            fs.unlinkSync(testDbPath);
            const walPath = testDbPath + '-wal';
            if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
            const shmPath = testDbPath + '-shm';
            if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
        } catch (e) {
            // ignore
        }
    });

    /**
     * 测试场景：批量插入消息后，session 的 last_message_at 应为最新消息的时间
     * 
     * 验证修复：之前 last_message_at 被错误地设置为当前时间(now)，
     * 修复后应设置为批量中最新消息的时间戳
     */
    it('应正确更新 last_message_at 为最新消息时间，而非当前时间', async () => {
        const sessionKey = 'agent:main:local:default:direct:test-session-001';
        const baseTime = new Date('2026-04-11T10:00:00.000Z');

        // 创建 session
        const session: Session = {
            sessionKey,
            agentId: 'main',
            channel: 'local',
            createdAt: baseTime,
            updatedAt: baseTime,
            messageCount: 0,
        };
        await db.upsertSession(session);

        // 准备消息：3条消息，时间递增
        const messages: SessionMessage[] = [
            {
                sessionKey,
                messageType: 'user',
                content: '第一条消息',
                timestamp: new Date(baseTime.getTime() + 1000),  // +1秒
            },
            {
                sessionKey,
                messageType: 'agent',
                content: '第二条消息',
                timestamp: new Date(baseTime.getTime() + 2000),  // +2秒
            },
            {
                sessionKey,
                messageType: 'user',
                content: '第三条消息（最新）',
                timestamp: new Date(baseTime.getTime() + 3000),  // +3秒 - 这是最新的
            },
        ];

        // 批量插入消息
        await db.batchInsertMessages(messages);

        // 获取 session
        const updatedSession = await db.getSession(sessionKey);

        expect(updatedSession).not.toBeNull();
        expect(updatedSession!.messageCount).toBe(3);
        
        // 关键验证：last_message_at 应该是最新消息的时间（+3000ms），而不是当前时间
        const expectedLastMessageTime = new Date(baseTime.getTime() + 3000);
        const actualLastMessageTime = updatedSession!.lastMessageAt;

        console.log('预期 last_message_at:', expectedLastMessageTime.toISOString());
        console.log('实际 last_message_at:', actualLastMessageTime?.toISOString());
        console.log('当前时间:', new Date().toISOString());

        // last_message_at 应该等于最新消息时间，而不是当前时间
        expect(actualLastMessageTime).toEqual(expectedLastMessageTime);
        
        // 额外验证：如果 diffFromNow 很大（>3600秒=1小时），说明用的是消息时间而非当前时间
        // 这是修复正确的证明
        const now = new Date();
        const diffFromNow = Math.abs((actualLastMessageTime!.getTime() - now.getTime()) / 1000);
        // 如果 diff > 3600秒（1小时），说明用的是消息时间，不是当前时间
        // 这个大差距正好证明修复是正确的
        expect(diffFromNow).toBeGreaterThan(3600); // 应该大于1小时
    });

    /**
     * 测试场景：多批次插入时，last_message_at 应跨批次正确更新
     */
    it('多批次插入时，last_message_at 应为所有批次中的最新消息时间', async () => {
        const sessionKey = 'agent:main:local:default:direct:test-session-002';
        const baseTime = new Date('2026-04-11T11:00:00.000Z');

        // 创建 session
        const session: Session = {
            sessionKey,
            agentId: 'main',
            channel: 'local',
            createdAt: baseTime,
            updatedAt: baseTime,
            messageCount: 0,
        };
        await db.upsertSession(session);

        // 第一批次：2条消息
        const batch1: SessionMessage[] = [
            {
                sessionKey,
                messageType: 'user',
                content: '第一批第1条',
                timestamp: new Date(baseTime.getTime() + 1000),
            },
            {
                sessionKey,
                messageType: 'agent',
                content: '第一批第2条',
                timestamp: new Date(baseTime.getTime() + 2000),
            },
        ];

        // 第二批次：1条消息（更新鲜）
        const batch2: SessionMessage[] = [
            {
                sessionKey,
                messageType: 'user',
                content: '第二批第1条（最新）',
                timestamp: new Date(baseTime.getTime() + 5000), // 5秒后，比第一批都新
            },
        ];

        // 分别插入两批次
        await db.batchInsertMessages(batch1);
        
        // 检查第一批次后的状态
        let updatedSession = await db.getSession(sessionKey);
        expect(updatedSession!.messageCount).toBe(2);
        expect(updatedSession!.lastMessageAt).toEqual(new Date(baseTime.getTime() + 2000));

        // 插入第二批次
        await db.batchInsertMessages(batch2);

        // 验证最终状态
        updatedSession = await db.getSession(sessionKey);
        expect(updatedSession!.messageCount).toBe(3);
        
        // 关键验证：last_message_at 应该是批次2的最新时间（+5000ms）
        expect(updatedSession!.lastMessageAt).toEqual(new Date(baseTime.getTime() + 5000));
    });

    /**
     * 测试场景：不同 session 的 last_message_at 应该独立更新
     */
    it('不同 session 的 last_message_at 应独立更新', async () => {
        const sessionKey1 = 'agent:main:local:default:direct:test-session-003a';
        const sessionKey2 = 'agent:dev:local:default:direct:test-session-003b';
        const baseTime = new Date('2026-04-11T12:00:00.000Z');

        // 创建两个 session
        for (const sk of [sessionKey1, sessionKey2]) {
            await db.upsertSession({
                sessionKey: sk,
                agentId: sk.includes('main') ? 'main' : 'dev',
                channel: 'local',
                createdAt: baseTime,
                updatedAt: baseTime,
                messageCount: 0,
            });
        }

        // session1 的消息（较旧）
        const messages1: SessionMessage[] = [
            {
                sessionKey: sessionKey1,
                messageType: 'user',
                content: 'session1 消息',
                timestamp: new Date(baseTime.getTime() + 1000),
            },
        ];

        // session2 的消息（较新）
        const messages2: SessionMessage[] = [
            {
                sessionKey: sessionKey2,
                messageType: 'user',
                content: 'session2 消息（时间更新）',
                timestamp: new Date(baseTime.getTime() + 5000),
            },
        ];

        await db.batchInsertMessages(messages1);
        await db.batchInsertMessages(messages2);

        const session1 = await db.getSession(sessionKey1);
        const session2 = await db.getSession(sessionKey2);

        expect(session1!.lastMessageAt).toEqual(new Date(baseTime.getTime() + 1000));
        expect(session2!.lastMessageAt).toEqual(new Date(baseTime.getTime() + 5000));
    });
});
