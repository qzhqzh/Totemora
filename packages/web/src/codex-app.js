import { initializeOperatorSession } from "./shared/operator-session.js";
import { registerFeature } from "./shared/app-context.js";
import { createCodexSupervisorFeature } from "./features/codex-supervisor.js";
import { createCodexScheduledSubscriptionsFeature } from "./features/codex-scheduled-subscriptions.js";

registerFeature("codex", createCodexSupervisorFeature());
registerFeature("codexScheduledSubscriptions", createCodexScheduledSubscriptionsFeature());
initializeOperatorSession();
