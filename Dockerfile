# ENDZONE server image. No secrets are baked in: set ENDZONE_TOKEN / ENDZONE_WRITE_TOKEN at runtime.
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 ENDZONE_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.js"]
