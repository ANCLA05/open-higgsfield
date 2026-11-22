
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { MODELS, getModel, parseSettings } from "@/generation/catalog";
import type {
  GenerationPlane,
  MediaItem,
  MediaRole,
} from "@/generation/catalog/types";
import { createPlatformClient } from "@/generation/platform";
import { toPlatform } from "@/generation/to-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-03-26";

function authorized(request: NextRequest): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  const supplied = request.headers.get("authorization") ?? "";

  if (!expected || !supplied.startsWith("Bearer ")) return false;

  const actual = supplied.slice(7);
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonRpc(id: unknown, result: unknown) {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function rpcError(id: unknown, code: number, message: string) {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseMedia(
  input: unknown,
  model: ReturnType<typeof getModel>,
): GenerationPlane["media"] {
  const source = record(input);
  const media: GenerationPlane["media"] = {};
  const roles: MediaRole[] = [
    "start",
    "end",
    "reference",
    "video",
    "audio",
  ];

  for (const role of roles) {
    const items = source[role];
    if (items === undefined) continue;

    if (!Array.isArray(items)) {
      throw new Error(`Media role "${role}" must be an array`);
    }

    const maximum = model.roles[role] ?? 0;

    if (items.length > maximum) {
      throw new Error(
        `Model ${model.id} allows at most ${maximum} "${role}" items`,
      );
    }

    const parsed: MediaItem[] = items.map((item) => {
      const entry = record(item);

      if (
        typeof entry.id !== "string" ||
        typeof entry.url !== "string"
      ) {
        throw new Error(`Each "${role}" item needs an id and url`);
      }

      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        throw new Error(`Invalid URL in "${role}" media`);
      }

      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("Media URLs must use HTTP or HTTPS");
      }

      return {
        id: entry.id,
        url: url.toString(),
        role,
      };
    });

    media[role] = parsed;
  }

  return media;
}

function getClient() {
  const apiKey = process.env.MCP_HIGGSFIELD_API_KEY;
  const baseUrl = process.env.HF_API_BASE_URL;

  if (!apiKey || !baseUrl) {
    throw new Error("Server API configuration is incomplete");
  }

  return createPlatformClient({ apiKey, baseUrl });
}

const tools = [
  {
    name: "list_models",
    description: "List available Higgsfield generation models and their settings.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "generate_media",
    description: "Submit an image or video generation request to Higgsfield.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        settings: { type: "object" },
        media: {
          type: "object",
          properties: {
            start: { type: "array" },
            end: { type: "array" },
            reference: { type: "array" },
            video: { type: "array" },
            audio: { type: "array" },
          },
        },
      },
      required: ["model", "prompt"],
    },
  },
  {
    name: "check_generation",
    description: "Check the status of one or more Higgsfield generation requests.",
    inputSchema: {
      type: "object",
      properties: {
        requestIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
        },
      },
      required: ["requestIds"],
    },
  },
];

async function callTool(
  name: string,
  args: Record<string, unknown>,
) {
  if (name === "list_models") {
    return textResult(
      MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        surface: model.surface,
        roles: model.roles,
        settings: model.settings,
      })),
    );
  }

  if (name === "generate_media") {
    if (
      typeof args.model !== "string" ||
      typeof args.prompt !== "string" ||
      !args.prompt.trim()
    ) {
      throw new Error("A model and non-empty prompt are required");
    }

    if (args.prompt.length > 20000) {
      throw new Error("Prompt is too long");
    }

    const model = getModel(args.model);
    const settings = parseSettings(model, record(args.settings));
    const media = parseMedia(args.media, model);

    const plane: GenerationPlane = {
      model: model.id,
      prompt: { text: args.prompt },
      media,
      settings,
    };

    const mapped = toPlatform(plane);
    const result = await getClient().submit(mapped.path, mapped.body);

    return textResult(result);
  }

  if (name === "check_generation") {
    const ids = args.requestIds;

    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 50 ||
      !ids.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 500,
      )
    ) {
      throw new Error("requestIds must contain 1–50 valid request IDs");
    }

    const client = getClient();

    const results = await Promise.all(
      ids.map(async (requestId) => {
        try {
          return {
            requestId,
            status: await client.status(requestId),
          };
        } catch (error) {
          return {
            requestId,
            error:
              error instanceof Error
                ? error.message
                : "Status request failed",
          };
        }
      }),
    );

    return textResult(results);
  }

  throw new Error(`Unknown tool: ${name}`);
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;

  try {
    body = record(await request.json());
  } catch {
    return rpcError(null, -32700, "Invalid JSON");
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body.id ?? null, -32600, "Invalid JSON-RPC request");
  }

  const id = body.id;
  const method = body.method;
  const params = record(body.params);

  if (id === undefined) {
    return new NextResponse(null, { status: 202 });
  }

  if (method === "initialize") {
    return jsonRpc(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: "open-higgsfield",
        version: "1.0.0",
      },
    });
  }

  if (method === "ping") {
    return jsonRpc(id, {});
  }

  if (method === "tools/list") {
    return jsonRpc(id, { tools });
  }

  if (method === "tools/call") {
    if (typeof params.name !== "string") {
      return rpcError(id, -32602, "Tool name is required");
    }

    try {
      const result = await callTool(
        params.name,
        record(params.arguments),
      );
      return jsonRpc(id, result);
    } catch (error) {
      return jsonRpc(id, {
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "Tool execution failed",
          },
        ],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, "Method not found");
}

export async function GET() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}

export async function DELETE() {
  return new NextResponse("Method Not Allowed", { status: 405 });
}
