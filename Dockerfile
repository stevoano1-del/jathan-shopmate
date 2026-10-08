FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./dist/server.mjs
COPY index.html shopmate.js shopmate.css favicon.svg manifest.webmanifest sw.js icon-192.png icon-512.png ./dist/client/
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=3000 DATA_DIR=/data SECURE_COOKIE=true
EXPOSE 3000
CMD ["node","dist/server.mjs"]
