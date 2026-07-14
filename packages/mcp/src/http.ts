import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "node:crypto";

import { TotemoraGatewayClient } from "./gateway-client";
import { createTotemoraMcpServer } from "./server";

export interface TotemoraMcpHttpOptions {
  gatewayUrl: string;
  operatorToken: string;
  fetch?: typeof fetch;
}

export function createTotemoraMcpHttpHandler(options: TotemoraMcpHttpOptions) {
  return async (request: Request): Promise<Response> => {
    if (!authorized(request, options.operatorToken)) {
      return Response.json({ error: "MCP authorization failed" }, { status: 401 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    const gateway = new TotemoraGatewayClient(options);
    const server = createTotemoraMcpServer(gateway);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await server.close();
    return response;
  };
}

function authorized(request: Request, token: string): boolean {
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(token);
  const providedBuffer = Buffer.from(provided);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}
