#!/bin/bash
# verify.sh - 验证所有 Docker 服务是否正常运行
ERRORS=0

echo "=== Ice Bubble Docker 验证脚本 ==="
echo "时间: $(date)"
echo ""

# 1. 容器运行状态
echo "--- 容器状态 ---"
for name in ice-openclaw-gateway ice-bubble-admin ice-bubble-collector-openclaw ice-bubble-collector-opencode ice-bubble-opendesign; do
    if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
        echo "✅ $name 运行中"
    else
        echo "❌ $name 未运行"
        ERRORS=$((ERRORS+1))
    fi
done
echo ""

# 2. 端口映射
echo "--- 端口检查 ---"
declare -A PORTS
PORTS[ice-openclaw-gateway]=18790
PORTS[ice-bubble-admin]=13001
PORTS[ice-bubble-collector-openclaw]=13110
PORTS[ice-bubble-collector-opencode]=13111
PORTS[ice-bubble-opendesign]=7457

for name in ice-openclaw-gateway ice-bubble-admin ice-bubble-collector-openclaw ice-bubble-collector-opencode ice-bubble-opendesign; do
    port=${PORTS[$name]}
    if docker port "$name" 2>/dev/null | grep -q "$port"; then
        echo "✅ $name 端口 $port 已映射"
    else
        echo "❌ $name 端口 $port 未监听"
        ERRORS=$((ERRORS+1))
    fi
done
echo ""

# 3. 健康检查
echo "--- 健康检查 ---"
for name in ice-openclaw-gateway ice-bubble-admin ice-bubble-collector-openclaw ice-bubble-collector-opencode ice-bubble-opendesign; do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
        echo "✅ $name 健康状态: $status"
    elif [ "$status" = "starting" ]; then
        echo "⚠️  $name 健康状态: $status (启动中)"
    else
        echo "❌ $name 健康状态: $status"
        ERRORS=$((ERRORS+1))
    fi
done
echo ""

# 4. OpenClaw Docker socket
echo "--- Docker Socket 测试 ---"
if docker exec ice-openclaw-gateway docker ps --format '{{.Names}}' > /dev/null 2>&1; then
    echo "✅ OpenClaw 可以通过 Docker socket 操作 Docker"
else
    echo "❌ OpenClaw Docker socket 访问失败"
    ERRORS=$((ERRORS+1))
fi

# 5. Chromium
if docker exec ice-openclaw-gateway chromium --version > /dev/null 2>&1; then
    echo "✅ Chromium 可用"
else
    echo "❌ Chromium 不可用"
    ERRORS=$((ERRORS+1))
fi

# 6. 数据卷
echo "--- 数据卷检查 ---"
if docker exec ice-openclaw-gateway test -d /home/dabai/.openclaw 2>/dev/null; then
    echo "✅ ~/.openclaw 已挂载"
else
    echo "❌ ~/.openclaw 未挂载"
    ERRORS=$((ERRORS+1))
fi

if docker exec ice-bubble-admin test -f /home/dabai/.local/share/ice-bubble/data/admin.db 2>/dev/null; then
    echo "✅ admin.db 可访问"
else
    echo "⚠️  admin.db 不可访问 (首次启动可能未创建)"
fi
echo ""

# 7. 最近日志
echo "--- 最近日志 ---"
for name in ice-openclaw-gateway ice-bubble-admin ice-bubble-collector-openclaw ice-bubble-collector-opencode ice-bubble-opendesign; do
    echo "[$name]"
    docker logs --tail 3 "$name" 2>&1 | sed 's/^/  /'
    echo ""
done

echo "==============================="
if [ $ERRORS -eq 0 ]; then
    echo "✅ 所有检查通过！"
else
    echo "❌ $ERRORS 个检查失败"
fi
exit $ERRORS
