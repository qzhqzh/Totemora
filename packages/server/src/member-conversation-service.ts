import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AgentConfig, LocalConfigSet, ProviderRegistry } from "@totemora/core";

import { MemberStateStore } from "./member-state-store";

export interface ConversationMessage {
  id: string;
  member_id: string;
  role: "user" | "member" | "help_request" | "mentor_guidance";
  content: string;
  author_id: string;
  at: string;
}

export class MemberConversationService {
  private readonly path: string;
  private queue = Promise.resolve();

  constructor(
    private readonly config: LocalConfigSet,
    private readonly providers: ProviderRegistry,
    private readonly memberState: MemberStateStore,
    dataDir: string,
  ) {
    this.path = resolve(dataDir, "member-conversations.json");
  }

  async chat(memberId: string, content: string, askMentor = false) {
    const member = this.requireMember(memberId);
    if (!content.trim()) throw new Error("Message cannot be empty");
    if (content.length > 8_000) throw new Error("Message is too long");
    const userMessage = await this.append(memberId, "user", content.trim(), "user");
    const dossier = await this.memberState.getDossier(memberId);
    const history = (await this.list(memberId)).filter((message) => message.id !== userMessage.id).slice(-16);
    let guidance: ConversationMessage | undefined;
    if (askMentor) {
      const mentorId = member.lineage?.mentor_id;
      if (!mentorId) throw new Error(`${member.name ?? member.id} has no mentor`);
      const mentor = this.requireMember(mentorId);
      await this.append(memberId, "help_request", content.trim(), member.id);
      await this.memberState.remember({
        member_id: member.id, kind: "help_request", summary: `向 ${mentor.name ?? mentor.id} 求助：${content.trim().slice(0, 240)}`,
        verified: false, source_id: userMessage.id,
      });
      const mentorResponse = await this.providers.get(mentor.provider).generate({
        memberId: mentor.id, model: mentor.model, maxTokens: 2_000,
        messages: [
          { role: "system", content: `${mentor.persona ?? ""}\n你现在是同一专业谱系中的导师。给晚辈具体指点，但不要替他冒充完成最终回答。` },
          { role: "user", content: `晚辈：${member.name ?? member.id}\n问题：${content.trim()}\n其当前能力：${JSON.stringify(member.profile)}\n请给出简洁的判断框架、风险提醒和下一步。` },
        ],
      });
      guidance = await this.append(memberId, "mentor_guidance", mentorResponse.content, mentor.id);
      await this.memberState.remember({
        member_id: member.id, kind: "guidance", summary: `${mentor.name ?? mentor.id} 指点：${mentorResponse.content.slice(0, 300)}`,
        verified: false, source_id: guidance.id,
      });
    }
    const response = await this.providers.get(member.provider).generate({
      memberId: member.id, model: member.model, maxTokens: 3_000,
      messages: [
        { role: "system", content: this.memberSystemPrompt(member, dossier) },
        ...history.map((message) => ({
          role: message.role === "user" ? "user" as const : "assistant" as const,
          content: `${message.role}: ${message.content}`,
        })),
        ...(guidance ? [{ role: "user" as const, content: `导师刚刚给你的指点：${guidance.content}\n请吸收指点后，以你自己的身份回答用户。` }] : []),
        { role: "user", content: content.trim() },
      ],
    });
    const reply = await this.append(memberId, "member", response.content, member.id);
    await this.memberState.remember({
      member_id: member.id, kind: "conversation", summary: `与用户交流：${content.trim().slice(0, 160)}`,
      verified: false, source_id: reply.id,
    });
    return { reply, guidance, dossier: await this.memberState.getDossier(memberId) };
  }

  async list(memberId?: string): Promise<ConversationMessage[]> {
    let messages: ConversationMessage[];
    try { messages = JSON.parse(await readFile(this.path, "utf8")) as ConversationMessage[]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return memberId ? messages.filter((item) => item.member_id === memberId) : messages;
  }

  private async append(memberId: string, role: ConversationMessage["role"], content: string, authorId: string) {
    const message: ConversationMessage = {
      id: crypto.randomUUID(), member_id: memberId, role, content,
      author_id: authorId, at: new Date().toISOString(),
    };
    const operation = this.queue.then(async () => {
      const messages = await this.list();
      messages.push(message);
      await atomicWrite(this.path, messages.slice(-2_000));
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return message;
  }

  private memberSystemPrompt(member: AgentConfig, dossier: Awaited<ReturnType<MemberStateStore["getDossier"]>>) {
    return [
      member.persona ?? `你是部落成员 ${member.name ?? member.id}`,
      "保持自己的性格和专业边界，不要假装是 Chief 或其他成员。",
      `你的谱系与成长状态：${JSON.stringify(dossier.identity)}；${JSON.stringify(dossier.growth)}`,
      `你记得的最近经历：${JSON.stringify(dossier.experiences.slice(0, 12))}`,
      "经历可能包含成功、失败、求助和导师指点；只有 verified=true 的经历可当作已验证能力证据。",
    ].join("\n");
  }

  private requireMember(id: string): AgentConfig {
    const member = this.config.agents.agents.find((item) => item.id === id && !["inactive", "retired"].includes(item.status ?? "active"));
    if (!member) throw new Error(`Member is unavailable: ${id}`);
    return member;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
