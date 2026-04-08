#!/bin/bash

# ice-bubble-collector-openclaw WSL 启动脚本
# 使用方法: ./start-wsl.sh [dev|start|test]

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 Node.js 环境
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "未安装 Node.js，请先安装 Node.js 18+"
        echo "推荐使用 nvm 安装:"
        echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
        echo "  source ~/.bashrc"
        echo "  nvm install 18"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js 版本过低，需要 18+，当前版本: $(node -v)"
        exit 1
    fi
    
    print_success "Node.js 版本: $(node -v)"
}

# 检查 OpenClaw 目录
check_openclaw() {
    OPENCLAW_DIR="/home/dabai/.openclaw"
    
    if [ ! -d "$OPENCLAW_DIR" ]; then
        print_error "OpenClaw 目录不存在: $OPENCLAW_DIR"
        exit 1
    fi
    
    if [ ! -d "$OPENCLAW_DIR/agents" ]; then
        print_warning "OpenClaw agents 目录不存在，正在创建..."
        mkdir -p "$OPENCLAW_DIR/agents"
    fi
    
    print_success "OpenClaw 目录: $OPENCLAW_DIR"
}

# 检查依赖
check_dependencies() {
    if [ ! -d "node_modules" ]; then
        print_warning "未安装依赖，正在安装..."
        npm install
    fi
    
    print_success "依赖已安装"
}

# 检查构建
check_build() {
    if [ ! -d "dist" ]; then
        print_warning "未构建项目，正在构建..."
        npm run build
    fi
    
    print_success "项目已构建"
}

# 创建数据目录
create_data_dir() {
    DATA_DIR="../data"
    
    if [ ! -d "$DATA_DIR" ]; then
        print_info "创建数据目录: $DATA_DIR"
        mkdir -p "$DATA_DIR"
    fi
    
    print_success "数据目录: $(cd $DATA_DIR && pwd)"
}

# 显示配置信息
show_config() {
    print_info "配置信息:"
    echo "  - OpenClaw 数据目录: /home/dabai/.openclaw"
    echo "  - 文件监听路径: /home/dabai/.openclaw/agents"
    echo "  - SQLite 数据库: $(cd ../data && pwd)/collector-dev.db"
    echo "  - 采集模式: FILE_ONLY"
    echo "  - 日志级别: debug"
    echo ""
}

# 主函数
main() {
    MODE=${1:-dev}
    
    print_info "ice-bubble-collector-openclaw WSL 启动脚本"
    echo "=========================================="
    echo ""
    
    # 环境检查
    print_info "检查环境..."
    check_node
    check_openclaw
    check_dependencies
    
    if [ "$MODE" != "test" ]; then
        check_build
        create_data_dir
    fi
    
    echo ""
    show_config
    
    # 根据模式执行
    case $MODE in
        dev)
            print_info "启动开发模式（热重载）..."
            npm run dev
            ;;
        start)
            print_info "启动生产模式..."
            npm start
            ;;
        test)
            print_info "运行测试..."
            npx vitest run
            ;;
        *)
            print_error "未知模式: $MODE"
            echo "使用方法: $0 [dev|start|test]"
            exit 1
            ;;
    esac
}

# 运行主函数
main "$@"
