# 现代战线 · 权威对局服务
#
# 没有构建步骤：js/ 与 lib/ 就是浏览器要跑的同一份源码，服务端直接 import 同一批模块。
# 所以镜像里不需要 node-gyp、不需要打包器，只要 node 运行时 + 两个依赖（ws、three）。
#
#   docker build -t mw-room .
#   docker run -d -p 8090:8090 -e ALLOW_ORIGIN=https://your.domain mw-room
#
# CMD 直接是 node 而不是 npm start：docker stop 发的 SIGTERM 只会给到 PID 1，
# 而 npm 会把信号留在自己的进程组里 —— 中间隔一层 npm，优雅下线（通知玩家重连、
# 停房间循环）就永远跑不到。用 --init 也是同一个目的，但少一个外部依赖更好。
FROM node:22-slim

# 只装生产依赖：playwright 是仓库里那套浏览器实证用的，镜像里不需要（它有几百 MB 浏览器）
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# node 镜像自带 uid=1000 的 node 用户。以 root 跑对局服务没有必要 ——
# 这个进程会被喂进任意客户端输入的 JSON 与二进制帧。
USER node

ENV NODE_ENV=production \
    PORT=8090 \
    HOST=0.0.0.0 \
    MAP=yard

EXPOSE 8090

# 健康检查用 node 自己发（slim 镜像里没有 curl/wget，装它们只为了探测不值）
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/net-server.mjs"]
