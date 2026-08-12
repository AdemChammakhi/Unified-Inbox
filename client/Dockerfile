# Frontend Dockerfile — hardened multi-stage build
# Stage 1: Build the React app
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .
# INLINE_RUNTIME_CHUNK=false keeps the webpack runtime as a file instead of an
# inline <script>, which lets the CSP use script-src 'self' with no
# 'unsafe-inline'. GENERATE_SOURCEMAP=false keeps sources out of production.
ENV INLINE_RUNTIME_CHUNK=false
ENV GENERATE_SOURCEMAP=false
RUN npm run build

# Stage 2: Serve with nginx (non-root)
FROM nginx:stable-alpine

# Upgrade vulnerable packages and remove default config
RUN apk upgrade --no-cache libxml2 && \
    rm -rf /etc/nginx/conf.d/default.conf

# Copy built files to nginx
COPY --from=build /app/build /usr/share/nginx/html

# Copy custom nginx config for React Router support
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Nginx needs to write to these dirs — adjust ownership for non-root
RUN chown -R nginx:nginx /usr/share/nginx/html \
 && chown -R nginx:nginx /var/cache/nginx \
 && chown -R nginx:nginx /var/log/nginx \
 && touch /var/run/nginx.pid \
 && chown nginx:nginx /var/run/nginx.pid

USER nginx

EXPOSE 80

# Use 127.0.0.1, not localhost: nginx listens on IPv4 only, while "localhost"
# can resolve to ::1 first — which makes the check fail with "connection
# refused" even though the site is serving normally.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
