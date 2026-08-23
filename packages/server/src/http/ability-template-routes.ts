import {
  AbilityTemplateInputError,
  AbilityTemplateNotFoundError,
  AbilityTemplateStore,
  type AbilityTemplateKind,
} from "../ability-template-store";
import { HttpError, json, readJson } from "./http-boundary";

interface AbilityTemplateRouteDependencies {
  store: AbilityTemplateStore;
  requireOperator(request: Request): void;
}

export async function handleAbilityTemplateRoutes(
  request: Request,
  url: URL,
  dependencies: AbilityTemplateRouteDependencies,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/ability-templates") {
    return json(dependencies.store.list());
  }

  const match = url.pathname.match(/^\/api\/ability-templates\/(prompt|workflow)\/([^/]+)$/);
  if (!match) return undefined;
  const kind = match[1] as AbilityTemplateKind;
  const id = decodeURIComponent(match[2]!);
  dependencies.requireOperator(request);
  try {
    if (request.method === "PUT") {
      return json(dependencies.store.update(kind, id, await readJson(request, 64_000)));
    }
    if (request.method === "DELETE") {
      dependencies.store.delete(kind, id);
      return json({ success: true, kind, id });
    }
    return undefined;
  } catch (error) {
    if (error instanceof AbilityTemplateInputError) throw new HttpError(400, error.message);
    if (error instanceof AbilityTemplateNotFoundError) throw new HttpError(404, error.message);
    throw error;
  }
}
