import { SkillRegistryService } from "../skill-registry-service";
import { json, readJson } from "./http-boundary";
import { inputObject, optionalString, optionalStringArray, requiredString } from "./input-schema";

interface SkillRegistryRouteDependencies {
  registry: SkillRegistryService;
  requireOperator(request: Request): void;
}

export async function handleSkillRegistryRoutes(
  request: Request,
  url: URL,
  dependencies: SkillRegistryRouteDependencies,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/skills/registry") {
    try {
      return json(await dependencies.registry.list({ refresh: url.searchParams.get("refresh") === "1" }));
    } catch (error) {
      console.error(JSON.stringify({ event: "skill_registry_scan_failed", error: message(error) }));
      return json({ error: "Skill registry scan failed" }, 500);
    }
  }

  if (request.method === "POST" && url.pathname === "/api/skills/registry") {
    dependencies.requireOperator(request);
    try {
      const input = skillInput(await readJson(request));
      return json(await dependencies.registry.create({
        ...input,
        id: requiredString(input.id, "id", 128),
        tags: input.tags ?? [],
      }), 201);
    } catch (error) {
      const detail = message(error);
      if (["Invalid Skill id", "Skill already exists", "Skill id is required"].includes(detail)) {
        return json({ error: detail }, 400);
      }
      throw error;
    }
  }

  const fileMatch = url.pathname.match(/^\/api\/skills\/registry\/([^/]+)\/file$/);
  if (request.method === "GET" && fileMatch) {
    dependencies.requireOperator(request);
    try {
      return json(await dependencies.registry.readFile(
        decodeURIComponent(fileMatch[1]!), url.searchParams.get("path") ?? "",
      ));
    } catch (error) {
      const detail = message(error);
      if (["Invalid Skill id", "Invalid Skill file path"].includes(detail)) return json({ error: detail }, 400);
      if (["Skill not found", "Skill file not found"].includes(detail)) return json({ error: detail }, 404);
      if (detail === "Skill file preview forbidden") return json({ error: detail }, 415);
      if (detail === "Skill file preview too large") return json({ error: detail }, 413);
      throw error;
    }
  }

  const match = url.pathname.match(/^\/api\/skills\/registry\/([^/]+)$/);
  if (!match) return undefined;
  const id = decodeURIComponent(match[1]!);
  if (request.method === "GET") {
    try {
      const skill = await dependencies.registry.get(id);
      return skill ? json(skill) : json({ error: "Skill not found" }, 404);
    } catch (error) {
      if (message(error) === "Invalid Skill id") return json({ error: message(error) }, 400);
      throw error;
    }
  }
  dependencies.requireOperator(request);
  if (request.method === "PUT") {
    try {
      return json(await dependencies.registry.update(id, skillInput(await readJson(request))));
    } catch (error) {
      const detail = message(error);
      if (["Invalid Skill id", "Skill file preview forbidden", "Skill file preview too large"].includes(detail)) {
        return json({ error: detail }, 400);
      }
      if (detail === "Skill not found") return json({ error: detail }, 404);
      throw error;
    }
  }
  if (request.method === "DELETE") {
    try {
      await dependencies.registry.delete(id);
      return json({ success: true, id });
    } catch (error) {
      const detail = message(error);
      if (detail === "Invalid Skill id") return json({ error: detail }, 400);
      if (detail === "Skill not found") return json({ error: detail }, 404);
      throw error;
    }
  }
  return undefined;
}

function skillInput(value: unknown) {
  const input = inputObject(value);
  return {
    id: input.id,
    name: optionalString(input.name, "name", 120),
    description: optionalString(input.description, "description", 1_000),
    content: optionalString(input.content, "content", 50_000, { trim: false, allowEmpty: true }),
    tags: optionalStringArray(input.tags, "tags", 50, 64),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
