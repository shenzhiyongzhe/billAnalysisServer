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
    return {
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
    };
  }

  async getAdminConfig() {
    const defaultQueries = await this.prisma.systemConfig.findUnique({
      where: { key: 'default_remaining_queries' },
    });
    const notice = await this.prisma.systemConfig.findUnique({
      where: { key: 'notice_text' },
    });

    return {
      defaultRemainingQueries: defaultQueries ? parseInt(defaultQueries.value, 10) : 500,
      noticeText: notice ? notice.value : '欢迎使用智能账单分析助手！',
    };
  }

  async updateAdminConfig(defaultRemainingQueries: number, noticeText: string) {
    await this.prisma.systemConfig.upsert({
      where: { key: 'default_remaining_queries' },
      update: { value: String(defaultRemainingQueries) },
      create: { key: 'default_remaining_queries', value: String(defaultRemainingQueries) },
    });

    await this.prisma.systemConfig.upsert({
      where: { key: 'notice_text' },
      update: { value: noticeText },
      create: { key: 'notice_text', value: noticeText },
    });

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
}
