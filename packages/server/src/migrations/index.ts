import type { Database } from "bun:sqlite";

import { applyInitialStateMigration } from "./001-initial-state";
import { applyIntelligenceDomainMigration } from "./002-intelligence-domain";
import { applySkillCommissionMigration } from "./003-skill-commission";
import { applySkillCommissionRevisionMigration } from "./004-skill-commission-revision";
import { applySkillTrialRunLeaseMigration } from "./005-skill-trial-run-lease";
import { applySkillTrialLeaseFencingMigration } from "./006-skill-trial-lease-fencing";
import { applyGitFlowSkillIdMigration } from "./007-git-flow-skill-id";
import { applySkillTrialOutcomeMigration } from "./008-skill-trial-outcome";
import { applyCodexSupervisorMigration } from "./009-codex-supervisor";
import { applyCodexThreadHistoryModeMigration } from "./010-codex-thread-history-mode";
import { applyCodexScheduledSubscriptionsMigration } from "./011-codex-scheduled-subscriptions";
import { applyReminderDomainMigration } from "./012-reminder-domain";
import { applyDealsDomainMigration } from "./013-deals-domain";
import type { StateMigration } from "./migration";

const migrations: readonly StateMigration[] = [
  applyInitialStateMigration,
  applyIntelligenceDomainMigration,
  applySkillCommissionMigration,
  applySkillCommissionRevisionMigration,
  applySkillTrialRunLeaseMigration,
  applySkillTrialLeaseFencingMigration,
  applyGitFlowSkillIdMigration,
  applySkillTrialOutcomeMigration,
  applyCodexSupervisorMigration,
  applyCodexThreadHistoryModeMigration,
  applyCodexScheduledSubscriptionsMigration,
  applyReminderDomainMigration,
  applyDealsDomainMigration,
];

export function runStateMigrations(db: Database): void {
  for (const migrate of migrations) migrate(db);
}
