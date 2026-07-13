import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  AI_SYSTEM_PROMPT_CONFIG_KEY,
  DEFAULT_AI_SYSTEM_PROMPT,
} from './ai-system-prompt.default';

@Injectable()
export class SystemConfigService {
  constructor(private prisma: PrismaService) {}

  async getPublicConfig() {
    const notice = await this.prisma.systemConfig.findUnique({
      where: { key: 'notice_text' },
    });
    const enableCustomPrompt = await this.prisma.systemConfig.findUnique({
      where: { key: 'enable_custom_prompt' },
    });
    return {
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
      enableCustomPrompt: enableCustomPrompt
        ? enableCustomPrompt.value === 'true'
        : false,
    };
  }

  async getAdminConfig() {
    const defaultQueries = await this.prisma.systemConfig.findUnique({
      where: { key: 'default_remaining_queries' },
    });
    const notice = await this.prisma.systemConfig.findUnique({
      where: { key: 'notice_text' },
    });
    const enableCustomPrompt = await this.prisma.systemConfig.findUnique({
      where: { key: 'enable_custom_prompt' },
    });

    return {
      defaultRemainingQueries: defaultQueries
        ? parseInt(defaultQueries.value, 10)
        : 500,
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
      enableCustomPrompt: enableCustomPrompt
        ? enableCustomPrompt.value === 'true'
        : false,
    };
  }

  async updateAdminConfig(
    defaultRemainingQueries: number,
    noticeText: string,
    enableCustomPrompt?: boolean,
  ) {
    await this.prisma.systemConfig.upsert({
      where: { key: 'default_remaining_queries' },
      update: { value: String(defaultRemainingQueries) },
      create: {
        key: 'default_remaining_queries',
        value: String(defaultRemainingQueries),
      },
    });

    await this.prisma.systemConfig.upsert({
      where: { key: 'notice_text' },
      update: { value: noticeText },
      create: { key: 'notice_text', value: noticeText },
    });

    if (enableCustomPrompt !== undefined) {
      await this.prisma.systemConfig.upsert({
        where: { key: 'enable_custom_prompt' },
        update: { value: String(enableCustomPrompt) },
        create: {
          key: 'enable_custom_prompt',
          value: String(enableCustomPrompt),
        },
      });
    }

    return { success: true };
  }

  async getAiSystemPrompt(): Promise<string> {
    const config = await this.prisma.systemConfig.findUnique({
      where: { key: AI_SYSTEM_PROMPT_CONFIG_KEY },
    });
    const prompt = config?.value?.trim();
    return prompt || DEFAULT_AI_SYSTEM_PROMPT;
  }

  async getAdminAiSystemPrompt() {
    const config = await this.prisma.systemConfig.findUnique({
      where: { key: AI_SYSTEM_PROMPT_CONFIG_KEY },
    });
    const stored = config?.value?.trim();
    return {
      prompt: stored || DEFAULT_AI_SYSTEM_PROMPT,
      isDefault: !stored,
    };
  }

  async updateAiSystemPrompt(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new BadRequestException('提示词不能为空');
    }

    await this.prisma.systemConfig.upsert({
      where: { key: AI_SYSTEM_PROMPT_CONFIG_KEY },
      update: { value: trimmed },
      create: { key: AI_SYSTEM_PROMPT_CONFIG_KEY, value: trimmed },
    });

    return { success: true };
  }

  async resetAiSystemPrompt() {
    await this.prisma.systemConfig.deleteMany({
      where: { key: AI_SYSTEM_PROMPT_CONFIG_KEY },
    });
    return {
      success: true,
      prompt: DEFAULT_AI_SYSTEM_PROMPT,
    };
  }

  getDefaultAiSystemPrompt() {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }

  async getUserOrSystemAiPrompt(userId: number): Promise<string> {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true, totalQueries: true },
    });
    const isAdmin = user?.level === 999;

    if (!isAdmin) {
      const enableCustomPromptConfig =
        await this.prisma.systemConfig.findUnique({
          where: { key: 'enable_custom_prompt' },
        });
      const enableCustomPromptSwitch = enableCustomPromptConfig
        ? enableCustomPromptConfig.value === 'true'
        : false;

      const userTotalQueries = user?.totalQueries || 0;
      const enableCustomPrompt = enableCustomPromptSwitch && userTotalQueries > 10;

      if (!enableCustomPrompt) {
        return this.getAiSystemPrompt();
      }
    }

    const userPrompt = await this.prisma.userPromptTemplate.findUnique({
      where: { userId },
    });
    if (userPrompt && userPrompt.prompt.trim()) {
      return userPrompt.prompt.trim();
    }
    return this.getAiSystemPrompt();
  }

  async getUserAiPromptDetail(userId: number) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true, totalQueries: true },
    });
    const isAdmin = user?.level === 999;
    const userTotalQueries = user?.totalQueries || 0;

    const enableCustomPromptConfig = await this.prisma.systemConfig.findUnique({
      where: { key: 'enable_custom_prompt' },
    });
    const enableCustomPromptSwitch = enableCustomPromptConfig
      ? enableCustomPromptConfig.value === 'true'
      : false;

    const enableCustomPrompt = isAdmin || (enableCustomPromptSwitch && userTotalQueries > 10);

    if (isAdmin) {
      const adminPrompt = await this.getAdminAiSystemPrompt();
      return {
        prompt: adminPrompt.prompt,
        isDefault: adminPrompt.isDefault,
        isAdmin: true,
        enableCustomPrompt,
        totalQueries: userTotalQueries,
      };
    }

    if (!enableCustomPrompt) {
      return {
        prompt: '',
        isDefault: true,
        isAdmin: false,
        enableCustomPrompt: false,
        totalQueries: userTotalQueries,
      };
    }

    const userPrompt = await this.prisma.userPromptTemplate.findUnique({
      where: { userId },
    });
    const stored = userPrompt?.prompt?.trim();
    return {
      prompt: stored || (await this.getAiSystemPrompt()),
      isDefault: !stored,
      isAdmin: false,
      enableCustomPrompt,
      totalQueries: userTotalQueries,
    };
  }

  async updateUserAiPrompt(userId: number, prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new BadRequestException('提示词不能为空');
    }

    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true },
    });
    const isAdmin = user?.level === 999;

    if (isAdmin) {
      return this.updateAiSystemPrompt(prompt);
    }

    const enableCustomPromptConfig = await this.prisma.systemConfig.findUnique({
      where: { key: 'enable_custom_prompt' },
    });
    const enableCustomPrompt = enableCustomPromptConfig
      ? enableCustomPromptConfig.value === 'true'
      : false;

    if (!enableCustomPrompt) {
      throw new BadRequestException('自定义提示词功能已被禁用');
    }

    await this.prisma.userPromptTemplate.upsert({
      where: { userId },
      update: { prompt: trimmed },
      create: { userId, prompt: trimmed },
    });

    return { success: true };
  }

  async resetUserAiPrompt(userId: number) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: { level: true },
    });
    const isAdmin = user?.level === 999;

    if (isAdmin) {
      return this.resetAiSystemPrompt();
    }

    const enableCustomPromptConfig = await this.prisma.systemConfig.findUnique({
      where: { key: 'enable_custom_prompt' },
    });
    const enableCustomPrompt = enableCustomPromptConfig
      ? enableCustomPromptConfig.value === 'true'
      : false;

    if (!enableCustomPrompt) {
      throw new BadRequestException('自定义提示词功能已被禁用');
    }

    await this.prisma.userPromptTemplate.deleteMany({
      where: { userId },
    });

    const defaultPrompt = await this.getAiSystemPrompt();
    return {
      success: true,
      prompt: defaultPrompt,
    };
  }
}
