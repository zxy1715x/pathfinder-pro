# 使用完整版 (Debian Bullseye)，体积较大但内置工具全
FROM node:20-bullseye

WORKDIR /app
ENV TZ=Asia/Shanghai

# 既然是完整版，通常不需要 apt-get install curl 了
# 直接跳过 apt 步骤，避免 Kaniko 报错

# 清空代理配置
ENV HTTP_PROXY=""
ENV HTTPS_PROXY=""
ENV ALL_PROXY=""

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 4237 8080
CMD ["node", "index.js"]
