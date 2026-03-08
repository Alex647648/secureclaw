# SecureClaw Agent Container
# 容器内运行 Claude Code，node:20-alpine（轻量，无 Chromium 需求）

FROM node:20-alpine

# 安装 git（Claude Code 可能需要）
RUN apk add --no-cache git bash

# 全局安装 claude-code CLI（SDK 回退用）
RUN npm install -g @anthropic-ai/claude-code

# 创建应用目录
WORKDIR /app

# 复制 package 文件（利用 Docker 缓存层）
COPY agent-runner/package*.json ./

# 安装依赖
RUN npm install

# 复制源码
COPY agent-runner/ ./

# 编译 TypeScript
RUN npm run build

# 设置工作目录权限
RUN mkdir -p /home/node/group && chown -R node:node /home/node

# 切换到非 root 用户
USER node

# 工作目录设为 group 挂载点
WORKDIR /home/node/group

# 入口：直接运行编译后的 index.js
ENTRYPOINT ["node", "/app/dist/index.js"]
