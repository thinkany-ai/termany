import { migrateBotDescription, type BotIdentity, type BotSkillBinding } from "@termany/core";

interface BotProfileSource {
  title: string;
  agentDescription?: string;
  agentInstructions?: string;
  agentSkills?: BotSkillBinding[];
}

/** Include empty values to replace prior configuration in reused sessions. */
export function botIdentityForConversation(bot: BotProfileSource, displayName = bot.title): BotIdentity {
  return {
    name: displayName,
    description: migrateBotDescription(bot.agentDescription, bot.agentInstructions),
    instructions: "",
    skills: (bot.agentSkills ?? []).map((binding) => ({
      ...binding,
      ...(binding.contextFiles ? { contextFiles: [...binding.contextFiles] } : {}),
    })),
  };
}
