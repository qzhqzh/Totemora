#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { TotemoraGatewayClient } from "./gateway-client";
import { createTotemoraMcpServer } from "./server";

const dataDir = process.env.TOTEMORA_DATA_DIR ?? resolve(process.cwd(), ".totemora");
const operatorToken = process.env.TOTEMORA_OPERATOR_TOKEN ?? await readToken(resolve(dataDir, "operator-token"));
if (!operatorToken) throw new Error("TOTEMORA_OPERATOR_TOKEN or .totemora/operator-token is required");

const gateway = new TotemoraGatewayClient({
  gatewayUrl: process.env.TOTEMORA_GATEWAY_URL ?? "http://127.0.0.1:4310",
  operatorToken,
});
const server = createTotemoraMcpServer(gateway);
await server.connect(new StdioServerTransport());

async function readToken(path: string): Promise<string | undefined> {
  try { return (await readFile(path, "utf8")).trim() || undefined; }
  catch { return undefined; }
}
