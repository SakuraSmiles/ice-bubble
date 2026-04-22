#!/usr/bin/env python3
"""
Task Manager - 任务管理工具
支持: 创建、查询、更新、删除、循环控制
"""

import json
import sys
import os
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

TASK_STORE_PATH = os.path.expanduser("~/.openclaw/workspace/tasks/task-store.json")

def load_store() -> Dict:
    """加载任务存储"""
    if os.path.exists(TASK_STORE_PATH):
        with open(TASK_STORE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"tasks": {}, "counter": 0}

def save_store(store: Dict):
    """保存任务存储"""
    os.makedirs(os.path.dirname(TASK_STORE_PATH), exist_ok=True)
    with open(TASK_STORE_PATH, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False, indent=2)

def next_id() -> str:
    """生成下一个任务ID"""
    store = load_store()
    store["counter"] += 1
    task_id = f"TASK-{store['counter']:03d}"
    save_store(store)
    return task_id

def create_task(title: str, agent_id: str = "main", priority: str = "medium",
                task_type: str = "TODO", parent_id: Optional[str] = None,
                description: str = "", loop_target: Optional[str] = None,
                steps: Optional[List[str]] = None) -> Dict:
    """创建任务"""
    store = load_store()
    task_id = f"TASK-{store['counter'] + 1:03d}"
    
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    task = {
        "id": task_id,
        "title": title,
        "status": "pending",
        "priority": priority,
        "agent_id": agent_id,
        "type": task_type,
        "created_at": now,
        "updated_at": now,
        "parent_id": parent_id,
        "children_ids": [],
        "description": description,
        "loop_target": loop_target,
        "steps": steps or [],
        "current_step": 0,
        "loop_count": 0,
        "terminated_by": None
    }
    
    store["tasks"][task_id] = task
    store["counter"] += 1
    
    # 更新父任务的 children
    if parent_id and parent_id in store["tasks"]:
        store["tasks"][parent_id]["children_ids"].append(task_id)
    
    save_store(store)
    return task

def get_task(task_id: str) -> Optional[Dict]:
    """获取任务"""
    store = load_store()
    return store["tasks"].get(task_id)

def list_tasks(status: Optional[str] = None, agent_id: Optional[str] = None) -> List[Dict]:
    """列出任务"""
    store = load_store()
    tasks = list(store["tasks"].values())
    
    if status:
        tasks = [t for t in tasks if t["status"] == status]
    if agent_id:
        tasks = [t for t in tasks if t["agent_id"] == agent_id]
    
    return sorted(tasks, key=lambda t: t["created_at"], reverse=True)

def update_task(task_id: str, **kwargs) -> Optional[Dict]:
    """更新任务"""
    store = load_store()
    if task_id not in store["tasks"]:
        return None
    
    task = store["tasks"][task_id]
    task.update(kwargs)
    task["updated_at"] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    
    save_store(store)
    return task

def delete_task(task_id: str) -> bool:
    """删除任务"""
    store = load_store()
    if task_id not in store["tasks"]:
        return False
    
    task = store["tasks"][task_id]
    
    # 递归删除子任务
    for child_id in task.get("children_ids", []):
        delete_task(child_id)
    
    # 从父任务中移除
    if task["parent_id"] and task["parent_id"] in store["tasks"]:
        parent = store["tasks"][task["parent_id"]]
        parent["children_ids"].remove(task_id)
    
    del store["tasks"][task_id]
    save_store(store)
    return True

def done_task(task_id: str) -> Optional[Dict]:
    """完成任务"""
    return update_task(task_id, status="completed")

def block_task(task_id: str, reason: str = "") -> Optional[Dict]:
    """阻塞任务"""
    return update_task(task_id, status="blocked", description=reason)

def stop_loop_task(task_id: str, terminated_by: str = "user") -> Optional[Dict]:
    """停止循环任务"""
    return update_task(task_id, 
                       status="loop_stopped",
                       terminated_by=terminated_by,
                       description=f"Loop stopped by {terminated_by}")

def get_progress(task_id: str) -> Dict:
    """获取任务进度"""
    store = load_store()
    if task_id not in store["tasks"]:
        return {"error": "Task not found"}
    
    task = store["tasks"]
    if not task["children_ids"]:
        return {"progress": 100 if task["status"] == "completed" else 0}
    
    total = len(task["children_ids"])
    completed = sum(1 for cid in task["children_ids"] if store["tasks"].get(cid, {}).get("status") == "completed")
    
    return {
        "task_id": task_id,
        "total": total,
        "completed": completed,
        "progress": int(completed / total * 100) if total > 0 else 0
    }

def main():
    """命令行入口"""
    if len(sys.argv) < 2:
        print("Usage: task.py <command> [args]")
        print("Commands: create, list, get, update, done, block, stop-loop, progress")
        sys.exit(1)
    
    cmd = sys.argv[1]
    
    if cmd == "create":
        title = sys.argv[2] if len(sys.argv) > 2 else "新任务"
        agent_id = sys.argv[3] if len(sys.argv) > 3 else "main"
        task = create_task(title, agent_id)
        print(f"Created: {task['id']} - {task['title']}")
    
    elif cmd == "list":
        tasks = list_tasks()
        for t in tasks:
            print(f"{t['id']} [{t['status']}] {t['title']} ({t['agent_id']})")
    
    elif cmd == "get" and len(sys.argv) > 2:
        task = get_task(sys.argv[2])
        if task:
            print(json.dumps(task, ensure_ascii=False, indent=2))
        else:
            print("Task not found")
    
    elif cmd == "done" and len(sys.argv) > 2:
        task = done_task(sys.argv[2])
        print(f"Done: {task['id']}" if task else "Task not found")
    
    elif cmd == "progress" and len(sys.argv) > 2:
        prog = get_progress(sys.argv[2])
        print(f"Progress: {prog.get('completed', 0)}/{prog.get('total', 0)} = {prog.get('progress', 0)}%")
    
    else:
        print(f"Unknown command: {cmd}")

if __name__ == "__main__":
    main()