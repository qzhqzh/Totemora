import { expect, test } from "bun:test";

import { HttpError } from "./http-boundary";
import { handleMemberRoutes, type MemberRouteServices } from "./member-routes";

test("member routes preserve public reads and protect mutations", async () => {
  const calls: unknown[][] = [];
  const services = memberServices(calls);
  const handle = (request: Request) => handleMemberRoutes(request, new URL(request.url), {
    async getServices() { return services; },
    requireOperator(candidate) {
      if (candidate.headers.get("authorization") !== "Bearer operator") {
        throw new HttpError(401, "Operator authorization failed");
      }
    },
  });

  expect(await handle(new Request("http://local/api/status"))).toBeUndefined();
  const dossiers = await handle(new Request("http://local/api/members/dossiers"));
  expect(await dossiers?.json()).toEqual({ members: [{ id: "member-1" }] });
  await expect(handle(new Request("http://local/api/members/member-1/chat", {
    method: "POST", body: JSON.stringify({ message: "hello" }),
  }))).rejects.toMatchObject({ status: 401 });

  const chat = await handle(new Request("http://local/api/members/member-1/chat", {
    method: "POST",
    headers: { authorization: "Bearer operator" },
    body: JSON.stringify({ message: "hello", ask_mentor: true }),
  }));
  expect(await chat?.json()).toEqual({ reply: "ok" });
  expect(calls).toContainEqual(["chat", "member-1", "hello", true]);
});

test("member routes validate mutation input and translate domain conflicts", async () => {
  const services = memberServices([]);
  const handle = (path: string, body: unknown) => handleMemberRoutes(new Request(`http://local${path}`, {
    method: "POST",
    headers: { authorization: "Bearer operator" },
    body: JSON.stringify(body),
  }), new URL(`http://local${path}`), {
    async getServices() { return services; },
    requireOperator() {},
  });

  await expect(handle("/api/members/member-1/chat", { message: "hello", ask_mentor: "yes" }))
    .rejects.toMatchObject({ status: 400 });
  await expect(handle("/api/members/member-1/evolution/proposals/proposal-1/review", {
    reviewer_id: "member-2", approve: "yes",
  })).rejects.toMatchObject({ status: 400 });
  await expect(handle("/api/members/member-1/evolution/proposals/proposal-1/review", {
    reviewer_id: "member-1", approve: true,
  })).rejects.toMatchObject({ status: 409 });

  await expect(handleMemberRoutes(
    new Request("http://local/api/members/missing"),
    new URL("http://local/api/members/missing"),
    { async getServices() { return services; }, requireOperator() {} },
  )).rejects.toMatchObject({ status: 404 });
});

function memberServices(calls: unknown[][]): MemberRouteServices {
  return {
    state: {
      async listDossiers() { return [{ id: "member-1" }] as any; },
      async getDossier(memberId) {
        if (memberId === "missing") throw new Error(`Member not found: ${memberId}`);
        return { id: memberId } as any;
      },
    },
    conversations: {
      async list(memberId) { calls.push(["list", memberId]); return [] as any; },
      async chat(memberId, message, askMentor) {
        calls.push(["chat", memberId, message, askMentor]);
        return { reply: "ok" } as any;
      },
    },
    evolution: {
      async propose(memberId) { calls.push(["propose", memberId]); return { id: "proposal-1" } as any; },
      async review(memberId, proposalId, reviewerId, approve) {
        calls.push(["review", memberId, proposalId, reviewerId, approve]);
        if (memberId === reviewerId) throw new Error("Evolution reviewer must differ from the subject member");
        return { id: proposalId } as any;
      },
    },
  };
}
