import type { MemberConversationService } from "../member-conversation-service";
import type { MemberEvolutionService } from "../member-evolution-service";
import type { MemberStateStore } from "../member-state-store";
import { HttpError, json, readJson } from "./http-boundary";
import { inputObject, optionalBoolean, requiredString } from "./input-schema";

export interface MemberRouteServices {
  state: Pick<MemberStateStore, "listDossiers" | "getDossier">;
  conversations: Pick<MemberConversationService, "list" | "chat">;
  evolution: Pick<MemberEvolutionService, "propose" | "review">;
}

export interface MemberRouteDependencies {
  getServices(): Promise<MemberRouteServices>;
  requireOperator(request: Request): void;
}

export async function handleMemberRoutes(
  request: Request,
  url: URL,
  dependencies: MemberRouteDependencies,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/members")) return undefined;

  if (request.method === "GET" && url.pathname === "/api/members/dossiers") {
    return json({ members: await (await dependencies.getServices()).state.listDossiers() });
  }

  const messages = url.pathname.match(/^\/api\/members\/([^/]+)\/messages$/);
  if (request.method === "GET" && messages) {
    return json({ messages: await (await dependencies.getServices()).conversations.list(messages[1]!) });
  }

  const evolutionProposal = url.pathname.match(/^\/api\/members\/([^/]+)\/evolution\/proposals$/);
  if (request.method === "POST" && evolutionProposal) {
    dependencies.requireOperator(request);
    return json(await translate(() => dependencies.getServices()
      .then((services) => services.evolution.propose(evolutionProposal[1]!))), 201);
  }

  const evolutionReview = url.pathname.match(
    /^\/api\/members\/([^/]+)\/evolution\/proposals\/([^/]+)\/review$/,
  );
  if (request.method === "POST" && evolutionReview) {
    dependencies.requireOperator(request);
    const input = inputObject(await readJson(request, 8_000));
    const reviewerId = requiredString(input.reviewer_id, "reviewer_id", 160);
    const approve = optionalBoolean(input.approve, "approve") ?? false;
    return json(await translate(() => dependencies.getServices().then((services) => services.evolution.review(
      evolutionReview[1]!, evolutionReview[2]!, reviewerId, approve,
    ))));
  }

  const chat = url.pathname.match(/^\/api\/members\/([^/]+)\/chat$/);
  if (request.method === "POST" && chat) {
    dependencies.requireOperator(request);
    const input = inputObject(await readJson(request, 16_000));
    const message = requiredString(input.message, "message", 8_000);
    const askMentor = optionalBoolean(input.ask_mentor, "ask_mentor") ?? false;
    return json(await translate(() => dependencies.getServices().then((services) =>
      services.conversations.chat(chat[1]!, message, askMentor),
    )));
  }

  const member = url.pathname.match(/^\/api\/members\/([^/]+)$/);
  if (request.method === "GET" && member) {
    return json(await translate(() => dependencies.getServices()
      .then((services) => services.state.getDossier(member[1]!))));
  }
  return undefined;
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.startsWith("Member not found:") || detail.startsWith("Member is unavailable:")) {
      throw new HttpError(404, detail);
    }
    if (detail.includes("has no mentor") || detail.startsWith("Evolution reviewer must")
      || detail.startsWith("Member has not reached") || detail.startsWith("A member cannot propose")) {
      throw new HttpError(409, detail);
    }
    throw error;
  }
}
