# 使用 Node.js 20 的 Debian-slim 版本
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 设置时区
ENV TZ=Asia/Shanghai

# ===================================================
# 核心修复 1: 安装 curl, unzip, tar 等缺失的系统依赖
# ===================================================
RUN apt-get update && \
    apt-get install -y curl unzip tar ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ===================================================
# 核心修复 2: 强制清除可能被意外注入的代理环境变量
# 防止 Axios 或 Curl 尝试连接容器内部的 0.0.0.0
# ===================================================
ENV HTTP_PROXY=""
ENV HTTPS_PROXY=""
ENV ALL_PROXY=""
ENV http_proxy=""
ENV https_proxy=""
ENV all_proxy=""

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制项目其余文件
COPY . .

# 暴露端口
EXPOSE 4237 8080

# 启动命令
CMD ["node", "index.js"]
