# Dev Rebuild Tips

When iterating on plugins or extensions during development, avoid full `docker build` (which takes 20-60 minutes). Use these faster approaches instead.

## Hot-patch a single plugin (~10 seconds)

Compile only the changed plugin with `tsc`, copy the output into the running container, and restart. No Docker build needed.

### 1. Compile the plugin

From the repo root:

```bash
node_modules/.bin/tsc \
  --ignoreConfig --noCheck \
  --module esnext --target es2022 --moduleResolution bundler \
  --isolatedModules --skipLibCheck --allowSyntheticDefaultImports \
  --rootDir extensions/<plugin-name> \
  --outDir /tmp/<plugin-name>-build \
  extensions/<plugin-name>/**/*.ts
```

Example for `nabu-model-router`:

```bash
node_modules/.bin/tsc \
  --ignoreConfig --noCheck \
  --module esnext --target es2022 --moduleResolution bundler \
  --isolatedModules --skipLibCheck --allowSyntheticDefaultImports \
  --rootDir extensions/nabu-model-router \
  --outDir /tmp/nabu-router-build \
  extensions/nabu-model-router/index.ts \
  extensions/nabu-model-router/api.ts \
  extensions/nabu-model-router/src/nabu-model-router.interface.ts \
  extensions/nabu-model-router/src/nabu-model-router.constants.ts \
  extensions/nabu-model-router/src/config.ts \
  extensions/nabu-model-router/src/router.ts \
  extensions/nabu-model-router/src/classifier.ts
```

**Flags explained:**

- `--ignoreConfig` — bypass the repo's `tsconfig.json` (avoids full project resolution)
- `--noCheck` — emit JS without type-checking (types are verified separately via `pnpm tsgo` or vitest)
- `--module esnext --moduleResolution bundler` — match openclaw's ESM output
- `--isolatedModules` — transpile each file independently (fast)

### 2. Copy into the running container

```bash
cd nabu-integration/instances/<instance-name>

# Remove old compiled output
docker compose exec openclaw-gateway rm -rf /app/dist/extensions/<plugin-name>

# Copy new compiled JS
docker compose cp /tmp/<plugin-name>-build openclaw-gateway:/app/dist/extensions/<plugin-name>

# Copy the manifest (needed for plugin discovery)
docker compose cp ../../../extensions/<plugin-name>/openclaw.plugin.json \
  openclaw-gateway:/app/dist/extensions/<plugin-name>/openclaw.plugin.json
```

### 3. Restart the gateway

```bash
docker compose restart openclaw-gateway
```

### 4. Verify

```bash
# Watch plugin logs
docker compose logs -f openclaw-gateway 2>&1 | grep <plugin-name>

# Send a test message
docker compose exec openclaw-cli node dist/index.js agent --agent main --message "test"
```

## One-liner for repeat iterations

After the first setup, combine compile + copy + restart into one command:

```bash
# From repo root (adjust paths for your instance)
node_modules/.bin/tsc \
  --ignoreConfig --noCheck \
  --module esnext --target es2022 --moduleResolution bundler \
  --isolatedModules --skipLibCheck --allowSyntheticDefaultImports \
  --rootDir extensions/nabu-model-router \
  --outDir /tmp/nabu-router-build \
  extensions/nabu-model-router/index.ts \
  extensions/nabu-model-router/api.ts \
  extensions/nabu-model-router/src/*.ts \
&& cd nabu-integration/instances/nabu-1 \
&& docker compose exec openclaw-gateway rm -rf /app/dist/extensions/nabu-model-router \
&& docker compose cp /tmp/nabu-router-build openclaw-gateway:/app/dist/extensions/nabu-model-router \
&& docker compose cp ../../../extensions/nabu-model-router/openclaw.plugin.json openclaw-gateway:/app/dist/extensions/nabu-model-router/openclaw.plugin.json \
&& docker compose restart openclaw-gateway \
&& cd ../../..
```

## Config-only changes (instant, no rebuild)

If you only changed `openclaw.json` (not plugin source code), the gateway hot-reloads most config keys automatically. No restart needed for:

- `agents.defaults.model.primary`
- `plugins.entries.<id>.config`
- `meta.*`

For changes that require a restart (e.g. `plugins.allow`, `gateway.*`):

```bash
cd nabu-integration/instances/<instance-name>
docker compose restart openclaw-gateway
```

## When you DO need a full Docker build

A full `docker build -t openclaw:local .` (from repo root) is required when:

- You added a **new plugin directory** under `extensions/` (first-time build only)
- You changed **core source** in `src/` (not just extensions)
- You modified **package.json** or **pnpm-lock.yaml** (dependency changes)
- You need the image for **CI/production deployment**

Use BuildKit for faster rebuilds (cached layers skip unchanged steps):

```bash
DOCKER_BUILDKIT=1 docker build -t openclaw:local .
```

Second builds are much faster than the first (~5-10 min vs 30-60 min) because the base image, pnpm store, and dependency layers are cached.

## Running tests locally

```bash
# Run a specific plugin's tests
node_modules/.bin/vitest run extensions/<plugin-name>/index.test.ts --no-coverage

# Run all tests
pnpm test
```

## Troubleshooting

### Plugin not loading after hot-patch

- Verify the manifest was copied: `docker compose exec openclaw-gateway ls /app/dist/extensions/<plugin-name>/openclaw.plugin.json`
- Verify JS files exist: `docker compose exec openclaw-gateway ls /app/dist/extensions/<plugin-name>/`
- Check for load errors: `docker compose logs openclaw-gateway 2>&1 | grep "<plugin-name>"`

### `fetch failed` or `other side closed` from plugin code

openclaw sets a global `EnvHttpProxyAgent` dispatcher (`src/infra/net/undici-global-dispatcher.ts`) that routes all `fetch()` calls through a proxy agent. If your plugin makes outbound HTTPS calls, use Node's native `https` module instead of `fetch()` to bypass this. See `extensions/nabu-model-router/src/classifier.ts` for the pattern.

### Plugin env vars not reaching the container

Docker Compose only forwards env vars explicitly listed in the service's `environment:` block. If you add a new env var to `.env`, also add it to `docker-compose.yml`:

```yaml
environment:
  MY_NEW_VAR: ${MY_NEW_VAR:-}
```
