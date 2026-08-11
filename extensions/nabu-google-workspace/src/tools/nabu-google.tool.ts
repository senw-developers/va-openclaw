import { jsonResult, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "../../api.js";
import { getLivePluginConfig } from "../config.js";
import {
  ALLOWED_METHODS,
  ALLOWED_PATH_PREFIXES,
  GOOGLE_API_BASE,
  GOOGLE_FETCH_TIMEOUT_MS,
  LOG_PREFIX,
  MAIN_AGENT_ID,
  TOOL_NAME,
} from "../nabu-google-workspace.constants.js";
import { getAccessTokenForUser, invalidateCachedToken } from "../token.js";

// Schema — flat object, no Type.Union (project guideline)

const NabuGoogleToolSchema = Type.Object(
  {
    method: stringEnum(ALLOWED_METHODS, {
      description: "HTTP method to send to Google APIs.",
    }),
    path: Type.String({
      description:
        "Path under https://www.googleapis.com — must start with /drive/v3/ or /calendar/v3/. Include path-segment ids inline (e.g. /calendar/v3/calendars/primary/events/abc).",
    }),
    query: Type.Optional(
      Type.Record(
        Type.String(),
        // String, number, or boolean — the tool stringifies before serializing.
        Type.Unknown(),
        {
          description:
            "Optional query-string params. Values may be string, number, or boolean. Example: { q: \"name contains 'review'\", pageSize: 20 }.",
        },
      ),
    ),
    body: Type.Optional(
      Type.Unknown({
        description:
          "JSON body for POST/PATCH/PUT. Omit for GET/DELETE. Tool serializes with JSON.stringify.",
      }),
    ),
  },
  { additionalProperties: false },
);

type NabuGoogleToolParams = {
  method: (typeof ALLOWED_METHODS)[number];
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
};

// Path / method gating — defense in depth alongside Google's own ACLs

const GOOGLE_API_HOST = new URL(GOOGLE_API_BASE).host;

/**
 * Validate the RESOLVED url — not the raw input — against the host and
 * path-prefix allowlists, so traversal, encoded traversal, protocol-relative
 * escapes and embedded absolute urls all fail. This is the security boundary.
 */
function buildAndValidateGoogleUrl(rawPath: string, query?: Record<string, unknown>): URL {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) {
    throw new Error(
      `Path must be an absolute path starting with /; got: ${String(rawPath).slice(0, 120)}`,
    );
  }
  const url = new URL(rawPath, GOOGLE_API_BASE);
  if (url.host !== GOOGLE_API_HOST) {
    throw new Error(`Host not allowed: ${url.host}`);
  }
  if (!ALLOWED_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    throw new Error(
      `Path not allowed: ${url.pathname}. Allowed prefixes: ${ALLOWED_PATH_PREFIXES.join(", ")}`,
    );
  }
  if (query) {
    for (const [key, raw] of Object.entries(query)) {
      const stringified = stringifyQueryValue(raw);
      if (stringified === null) continue;
      url.searchParams.set(key, stringified);
    }
  }
  return url;
}

function stringifyQueryValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

/**
 * Hard-delete of a Drive file is irreversible and soft-trash is equally
 * useful, so block it at the plugin layer — prompt injection must not be able
 * to coerce permanent data loss.
 */
function isBlockedDestructiveOp(method: string, pathname: string): boolean {
  if (method !== "DELETE") return false;
  return /^\/drive\/v3\/files\/[^/]+\/?$/.test(pathname);
}

// Tool registration

export function createNabuGoogleTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: TOOL_NAME,
    label: "Google Drive & Calendar",
    description:
      "Call Google Drive (v3) or Calendar (v3) REST APIs as the current end user. " +
      "Auth is handled by the nabu-google-workspace plugin; do not pass tokens. " +
      "See the nabu-google-workspace skill for path/body recipes.",
    parameters: NabuGoogleToolSchema,
    async execute(_toolCallId, params) {
      const p = params as NabuGoogleToolParams;
      try {
        const organizationId = process.env.OPENCLAW_ORGANIZATION_ID;
        if (!organizationId) {
          return jsonResult({
            error:
              "OPENCLAW_ORGANIZATION_ID is not set on the gateway; tenant identity unresolvable.",
          });
        }
        // Product gate the dashboard toggles, NOT a security boundary: agentId is
        // client-influenced and the tenant sandbox is off, so the backend enforces.
        const agentId = context.agentId ?? "";
        if (!getLivePluginConfig(api).allowNonMainAgents && agentId !== MAIN_AGENT_ID) {
          return jsonResult({
            error: `Agent "${agentId || "unknown"}" may not use Google Workspace — an admin can enable access for non-main agents.`,
          });
        }
        // Backend connections are keyed on the numeric app user id, so a
        // channel-native senderId (phone number, chat handle) would 404 against
        // a dashboard-created grant. Refuse rather than mis-attribute.
        const userId = context.requesterSenderId;
        if (typeof userId !== "string" || !/^\d+$/.test(userId)) {
          return jsonResult({
            error:
              "No numeric requester identity in tool context — Google calls require a per-user OAuth grant made from the dashboard.",
          });
        }
        const channel = context.messageChannel ?? "unknown";

        let url: URL;
        try {
          url = buildAndValidateGoogleUrl(p.path, p.query);
        } catch (err) {
          return jsonResult({ error: formatErrorMessage(err) });
        }
        if (isBlockedDestructiveOp(p.method, url.pathname)) {
          return jsonResult({
            error:
              "Hard-delete of Drive files is blocked. Use PATCH with body { trashed: true } instead — trashing is reversible; deleting is not.",
          });
        }

        // First attempt with the (possibly cached) access token.
        let outcome = await callGoogle(api, organizationId, channel, userId, url, p);

        // Retry-once on 401 with forced cache invalidation. Google can
        // server-side rotate tokens (re-consent, password change, sessions
        // control revoke) between cache check and request.
        if (outcome.status === 401) {
          api.logger.info(
            `${LOG_PREFIX} ${TOOL_NAME} got 401 — invalidating cache and retrying once`,
          );
          invalidateCachedToken(organizationId, channel, userId);
          outcome = await callGoogle(api, organizationId, channel, userId, url, p);
        }

        return jsonResult(outcome);
      } catch (err) {
        api.logger.error(`${LOG_PREFIX} ${TOOL_NAME} failed: ${formatErrorMessage(err)}`);
        return jsonResult({ error: formatErrorMessage(err) });
      }
    },
  } satisfies AnyAgentTool;
}

// Single Google call — handles content-type + error envelope

interface GoogleCallResult {
  status: number;
  url: string;
  method: string;
  ok: boolean;
  response?: unknown;
  /**
   * Encoding of `response` when it's a binary blob. Absent for JSON/text.
   */
  encoding?: "base64";
  /**
   * Hoisted from Google's error envelope when present.
   */
  errorReason?: string | null;
  retryAfterSeconds?: number;
  error?: string;
}

async function callGoogle(
  api: OpenClawPluginApi,
  organizationId: string,
  channel: string,
  userId: string,
  url: URL,
  p: NabuGoogleToolParams,
): Promise<GoogleCallResult> {
  const accessToken = await getAccessTokenForUser(api, organizationId, channel, userId);
  const init: RequestInit = {
    method: p.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(p.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
    ...(p.body !== undefined ? { body: JSON.stringify(p.body) } : {}),
  };

  const startedAt = Date.now();
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const looksJson = contentType.includes("application/json");
  const looksText = contentType.startsWith("text/") || looksJson;

  let response: unknown;
  let encoding: "base64" | undefined;

  if (looksText) {
    const text = await res.text();
    response = looksJson && text ? safeJson(text, api) : text;
  } else {
    // Binary: base64-encode so the agent gets stable JSON-safe payload
    // rather than UTF-8-corrupted bytes.
    const buf = Buffer.from(await res.arrayBuffer());
    response = buf.toString("base64");
    encoding = "base64";
  }

  api.logger.info(
    `${LOG_PREFIX} ${p.method} ${url.pathname} → ${res.status} (latency_ms=${Date.now() - startedAt})`,
  );

  if (!res.ok) {
    const result: GoogleCallResult = {
      status: res.status,
      url: url.href,
      method: p.method,
      ok: false,
      response,
      error: `Google API ${res.status} ${res.statusText}`,
      errorReason: extractErrorReason(response),
    };
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        result.retryAfterSeconds = seconds;
      }
    }
    return result;
  }

  return {
    status: res.status,
    url: url.href,
    method: p.method,
    ok: true,
    response,
    ...(encoding ? { encoding } : {}),
  };
}

function safeJson(text: string, api: OpenClawPluginApi): unknown {
  try {
    return JSON.parse(text);
  } catch {
    api.logger.warn(
      `${LOG_PREFIX} response had Content-Type: application/json but body was not JSON: ${text.slice(0, 200)}`,
    );
    return text;
  }
}

function extractErrorReason(response: unknown): string | null {
  if (response && typeof response === "object" && !Array.isArray(response)) {
    const error = (response as { error?: unknown }).error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const errors = (error as { errors?: unknown }).errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        if (
          first &&
          typeof first === "object" &&
          typeof (first as { reason?: unknown }).reason === "string"
        ) {
          return (first as { reason: string }).reason;
        }
      }
      if (typeof (error as { status?: unknown }).status === "string") {
        return (error as { status: string }).status;
      }
    }
  }
  return null;
}
