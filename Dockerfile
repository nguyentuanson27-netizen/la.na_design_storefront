# syntax=docker/dockerfile:1

# Full Bookworm is used instead of bookworm-slim because the slim variant does
# not provide the OpenSSL runtime Prisma requires. The multi-platform digest is
# pinned so base-image updates are explicit reviewed changes.
ARG NODE_IMAGE=node:22.22.0-bookworm@sha256:20a424ecd1d2064a44e12fe287bf3dae443aab31dc5e0c0cb6c74bef9c78911c

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN openssl version && corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN test "$(pnpm --version)" = "11.4.0" \
  && pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
# Build-only placeholders satisfy configuration imported during compilation.
# They are not production credentials and this stage is not the runtime image.
ENV DATABASE_URL=postgresql://build-only:build-only@127.0.0.1:5432/build-only
ENV BETTER_AUTH_SECRET=build-only-placeholder-secret-0123456789abcdef
ENV BETTER_AUTH_URL=http://localhost:3000
ENV BETTER_AUTH_IP_HEADER=x-build-client-ip
# The Meta pixel id is a build input, not a runtime one: next.config.mjs assembles the
# Content-Security-Policy from it and Next bakes that policy into the build. Left empty the image
# ships no tracking and no Facebook origin in the policy.
ARG NEXT_PUBLIC_FACEBOOK_PIXEL_ID=""
ENV NEXT_PUBLIC_FACEBOOK_PIXEL_ID=${NEXT_PUBLIC_FACEBOOK_PIXEL_ID}
RUN pnpm prisma:generate
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN test "$(pnpm --version)" = "11.4.0" \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=build --chown=node:node /app/src/generated/prisma ./src/generated/prisma
COPY --from=build --chown=node:node /app/public ./public


USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/shop').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
