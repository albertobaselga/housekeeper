# syntax=docker/dockerfile:1.17.1

ARG NODE_IMAGE=node:24.18.0-alpine3.23

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION=10.17.1
RUN corepack enable \
  && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /workspace

FROM base AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
ARG WORKSPACE_FILTER=@housekeeper/worker
RUN pnpm --filter "${WORKSPACE_FILTER}..." build

FROM base AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    WORKSPACE_FILTER=@housekeeper/worker
COPY --from=build --chown=node:node /workspace /workspace
USER node
EXPOSE 3001
CMD ["sh", "-c", "exec pnpm --filter \"${WORKSPACE_FILTER}\" start"]
