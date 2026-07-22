import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma.service';

const FEEDBACK_CATEGORIES = new Set([
  'login',
  'upload',
  'analysis',
  'recharge',
  'other',
]);

const FEEDBACK_STATUSES = new Set([
  'pending',
  'processing',
  'resolved',
  'ignored',
]);

const UNSUPPORTED_STATUSES = new Set([
  'open',
  'planned',
  'supported',
  'ignored',
]);

const MAX_EVENTS = 20;
const MAX_MESSAGE_LEN = 2000;
const MAX_CONTENT_LEN = 2000;
const RATE_WINDOW_MS = 60_000;
const MAX_FEEDBACK_PER_WINDOW = 5;
const MAX_ERROR_EVENTS_PER_WINDOW = 40;

@Injectable()
export class FeedbackService {
  private feedbackRate = new Map<number, number[]>();
  private errorRate = new Map<number | string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  async createFeedback(
    userId: number,
    body: {
      category?: string;
      content?: string;
      contact?: string;
      contextJson?: unknown;
    },
  ) {
    const category = (body.category || '').trim();
    const content = (body.content || '').trim();
    const contact = body.contact?.trim() || null;

    if (!FEEDBACK_CATEGORIES.has(category)) {
      throw new BadRequestException('无效的问题类型');
    }
    if (!content) {
      throw new BadRequestException('请填写问题描述');
    }
    if (content.length > MAX_CONTENT_LEN) {
      throw new BadRequestException(`问题描述不能超过 ${MAX_CONTENT_LEN} 字`);
    }
    if (contact && contact.length > 100) {
      throw new BadRequestException('联系方式过长');
    }
    if (!this.allowFeedback(userId)) {
      throw new BadRequestException('提交过于频繁，请稍后再试');
    }

    const contextJson = this.sanitizeContext(body.contextJson);

    const report = await this.prisma.feedbackReport.create({
      data: {
        userId,
        category,
        content,
        contact,
        contextJson: contextJson as Prisma.InputJsonValue,
      },
    });

    return { id: report.id, status: report.status, createdAt: report.createdAt };
  }

  async reportClientErrors(
    userId: number | null,
    events: Array<{
      level?: string;
      source?: string;
      message?: string;
      statusCode?: number;
      url?: string;
      page?: string;
      contextJson?: unknown;
      fingerprint?: string;
    }>,
  ) {
    if (!Array.isArray(events) || events.length === 0) {
      return { accepted: 0 };
    }
    if (events.length > MAX_EVENTS) {
      throw new BadRequestException(`单次最多上报 ${MAX_EVENTS} 条`);
    }

    const rateKey = userId ?? 'anon';
    if (!this.allowErrorEvents(rateKey, events.length)) {
      return { accepted: 0, throttled: true };
    }

    const rows: Prisma.ClientErrorLogCreateManyInput[] = [];
    for (const event of events) {
      const message = String(event.message || '').trim().slice(0, MAX_MESSAGE_LEN);
      if (!message) continue;

      if (
        event.statusCode === 401 ||
        message.includes('Invalid or expired access token') ||
        message.includes('Invalid access token')
      ) {
        continue;
      }

      const source = String(event.source || 'manual').slice(0, 32);
      const level = event.level === 'warn' ? 'warn' : 'error';
      const fingerprint = String(
        event.fingerprint || `${source}:${message.slice(0, 80)}`,
      ).slice(0, 200);

      rows.push({
        userId: userId ?? undefined,
        level,
        source,
        message,
        statusCode:
          typeof event.statusCode === 'number' && Number.isFinite(event.statusCode)
            ? Math.trunc(event.statusCode)
            : undefined,
        url: event.url ? String(event.url).slice(0, 500) : undefined,
        page: event.page ? String(event.page).slice(0, 200) : undefined,
        contextJson: this.sanitizeContext(event.contextJson) as
          | Prisma.InputJsonValue
          | undefined,
        fingerprint,
      });
    }

    if (rows.length === 0) {
      return { accepted: 0 };
    }

    const result = await this.prisma.clientErrorLog.createMany({ data: rows });
    return { accepted: result.count };
  }

  async listFeedback(
    search?: string,
    status?: string,
    category?: string,
    pageStr?: string,
    limitStr?: string,
  ) {
    const { page, limit, skip } = this.parsePage(pageStr, limitStr);
    const where: Prisma.FeedbackReportWhereInput = {};
    const cleanStatus = this.cleanQueryParam(status);
    const cleanCategory = this.cleanQueryParam(category);
    const cleanSearch = this.cleanQueryParam(search);

    if (cleanStatus && FEEDBACK_STATUSES.has(cleanStatus)) {
      where.status = cleanStatus;
    }
    if (cleanCategory && FEEDBACK_CATEGORIES.has(cleanCategory)) {
      where.category = cleanCategory;
    }
    if (cleanSearch) {
      where.OR = [
        { content: { contains: cleanSearch, mode: 'insensitive' } },
        { user: { nickname: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { displayId: cleanSearch } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.feedbackReport.findMany({
        where,
        include: {
          user: {
            select: { id: true, displayId: true, nickname: true, avatar: true },
          },
          handler: {
            select: { id: true, displayId: true, nickname: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.feedbackReport.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        userDisplayId: item.user.displayId,
        userNickname: item.user.nickname,
        userAvatar: item.user.avatar,
        category: item.category,
        content: item.content,
        contact: item.contact,
        status: item.status,
        contextJson: item.contextJson,
        adminNote: item.adminNote,
        handledBy: item.handledBy,
        handlerNickname: item.handler?.nickname ?? null,
        handlerDisplayId: item.handler?.displayId ?? null,
        handledAt: item.handledAt,
        createdAt: item.createdAt,
      })),
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };
  }

  async updateFeedback(
    id: number,
    adminId: number,
    body: { status?: string; adminNote?: string },
  ) {
    const existing = await this.prisma.feedbackReport.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('反馈不存在');
    }

    const data: Prisma.FeedbackReportUpdateInput = {};
    if (body.status != null) {
      if (!FEEDBACK_STATUSES.has(body.status)) {
        throw new BadRequestException('无效的状态');
      }
      data.status = body.status;
      data.handler = { connect: { id: adminId } };
      data.handledAt = new Date();
    }
    if (body.adminNote !== undefined) {
      data.adminNote = body.adminNote?.slice(0, 2000) || null;
      if (!body.status) {
        data.handler = { connect: { id: adminId } };
        data.handledAt = new Date();
      }
    }

    const updated = await this.prisma.feedbackReport.update({
      where: { id },
      data,
    });
    return updated;
  }

  async listClientErrors(
    search?: string,
    userIdStr?: string,
    statusCodeStr?: string,
    source?: string,
    pageStr?: string,
    limitStr?: string,
  ) {
    const { page, limit, skip } = this.parsePage(pageStr, limitStr);
    const where: Prisma.ClientErrorLogWhereInput = {};
    const cleanUserId = this.cleanQueryParam(userIdStr);
    const cleanStatusCode = this.cleanQueryParam(statusCodeStr);
    const cleanSource = this.cleanQueryParam(source);
    const cleanSearch = this.cleanQueryParam(search);

    if (cleanUserId && /^\d+$/.test(cleanUserId)) {
      where.userId = parseInt(cleanUserId, 10);
    }
    if (cleanStatusCode && /^-?\d+$/.test(cleanStatusCode)) {
      where.statusCode = parseInt(cleanStatusCode, 10);
    }
    if (cleanSource) {
      where.source = cleanSource;
    }
    if (cleanSearch) {
      where.OR = [
        { message: { contains: cleanSearch, mode: 'insensitive' } },
        { url: { contains: cleanSearch, mode: 'insensitive' } },
        { page: { contains: cleanSearch, mode: 'insensitive' } },
        { fingerprint: { contains: cleanSearch, mode: 'insensitive' } },
        { user: { nickname: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { displayId: cleanSearch } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.clientErrorLog.findMany({
        where,
        include: {
          user: {
            select: { id: true, displayId: true, nickname: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.clientErrorLog.count({ where }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        userDisplayId: item.user?.displayId ?? null,
        userNickname: item.user?.nickname ?? null,
        level: item.level,
        source: item.source,
        message: item.message,
        statusCode: item.statusCode,
        url: item.url,
        page: item.page,
        contextJson: item.contextJson,
        fingerprint: item.fingerprint,
        createdAt: item.createdAt,
      })),
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };
  }

  async listUnsupportedFormats(
    search?: string,
    fileExt?: string,
    reason?: string,
    status?: string,
    pageStr?: string,
    limitStr?: string,
  ) {
    const { page, limit, skip } = this.parsePage(pageStr, limitStr);
    const where: Prisma.UnsupportedFormatLogWhereInput = {};
    const cleanExt = this.cleanQueryParam(fileExt)?.toLowerCase();
    const cleanReason = this.cleanQueryParam(reason);
    const cleanStatus = this.cleanQueryParam(status);
    const cleanSearch = this.cleanQueryParam(search);

    if (cleanExt) {
      where.fileExt = cleanExt;
    }
    if (cleanReason) {
      where.reason = cleanReason;
    }
    if (cleanStatus && UNSUPPORTED_STATUSES.has(cleanStatus)) {
      where.status = cleanStatus;
    }
    if (cleanSearch) {
      where.OR = [
        { originalFileName: { contains: cleanSearch, mode: 'insensitive' } },
        { headerExcerpt: { contains: cleanSearch, mode: 'insensitive' } },
        { errorMessage: { contains: cleanSearch, mode: 'insensitive' } },
        { user: { nickname: { contains: cleanSearch, mode: 'insensitive' } } },
        { user: { displayId: cleanSearch } },
      ];
    }

    const [items, total, extGroups, reasonGroups] = await Promise.all([
      this.prisma.unsupportedFormatLog.findMany({
        where,
        include: {
          user: {
            select: { id: true, displayId: true, nickname: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.unsupportedFormatLog.count({ where }),
      this.prisma.unsupportedFormatLog.groupBy({
        by: ['fileExt'],
        where,
        _count: { _all: true },
        orderBy: { _count: { fileExt: 'desc' } },
        take: 20,
      }),
      this.prisma.unsupportedFormatLog.groupBy({
        by: ['reason'],
        where,
        _count: { _all: true },
        orderBy: { _count: { reason: 'desc' } },
        take: 20,
      }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        userId: item.userId,
        userDisplayId: item.user.displayId,
        userNickname: item.user.nickname,
        queryRecordId: item.queryRecordId,
        reason: item.reason,
        originalFileName: item.originalFileName,
        storedFileName: item.storedFileName,
        fileExt: item.fileExt,
        fileSize: item.fileSize,
        guessedSource: item.guessedSource,
        headerExcerpt: item.headerExcerpt,
        errorMessage: item.errorMessage,
        status: item.status,
        adminNote: item.adminNote,
        createdAt: item.createdAt,
      })),
      aggregates: {
        byExt: extGroups.map((g) => ({
          fileExt: g.fileExt,
          count: g._count._all,
        })),
        byReason: reasonGroups.map((g) => ({
          reason: g.reason,
          count: g._count._all,
        })),
      },
      total,
      page,
      limit,
      hasMore: skip + items.length < total,
    };
  }

  async updateUnsupportedFormat(
    id: number,
    body: { status?: string; adminNote?: string },
  ) {
    const existing = await this.prisma.unsupportedFormatLog.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('记录不存在');
    }

    const data: Prisma.UnsupportedFormatLogUpdateInput = {};
    if (body.status != null) {
      if (!UNSUPPORTED_STATUSES.has(body.status)) {
        throw new BadRequestException('无效的状态');
      }
      data.status = body.status;
    }
    if (body.adminNote !== undefined) {
      data.adminNote = body.adminNote?.slice(0, 2000) || null;
    }

    return this.prisma.unsupportedFormatLog.update({
      where: { id },
      data,
    });
  }

  async getUnsupportedFormatDownload(id: number) {
    const item = await this.prisma.unsupportedFormatLog.findUnique({
      where: { id },
    });
    if (!item || !item.storedFileName) {
      throw new NotFoundException('文件记录不存在');
    }
    const filePath = path.join(process.cwd(), 'uploads', item.storedFileName);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('原文件不存在或已被清除');
    }
    return {
      stream: fs.createReadStream(filePath),
      fileName: item.originalFileName || item.storedFileName,
    };
  }

  async getUserDiagnostics(userId: number) {
    const user = await this.prisma.wechatUser.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayId: true,
        nickname: true,
        avatar: true,
        remainingQueries: true,
        totalQueries: true,
        level: true,
        lastLoginAt: true,
        lastLoginIp: true,
        createdAt: true,
      },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const [feedback, errors, unsupported] = await Promise.all([
      this.prisma.feedbackReport.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.clientErrorLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.unsupportedFormatLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return { user, feedback, errors, unsupported };
  }

  private sanitizeContext(raw: unknown): Record<string, unknown> | undefined {
    if (raw == null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;

    const clone = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const banned = [
      'accessToken',
      'refreshToken',
      'Authorization',
      'authorization',
      'token',
      'password',
      'secret',
    ];

    const scrub = (obj: Record<string, unknown>, depth = 0) => {
      if (depth > 4) return;
      for (const key of Object.keys(obj)) {
        if (banned.some((b) => key.toLowerCase().includes(b.toLowerCase()))) {
          delete obj[key];
          continue;
        }
        const val = obj[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          scrub(val as Record<string, unknown>, depth + 1);
        }
      }
    };
    scrub(clone);

    const serialized = JSON.stringify(clone);
    if (serialized.length > 8000) {
      return { truncated: true, preview: serialized.slice(0, 4000) };
    }
    return clone;
  }

  private parsePage(pageStr?: string, limitStr?: string) {
    const page = pageStr ? Math.max(1, parseInt(pageStr, 10) || 1) : 1;
    const limit = limitStr
      ? Math.min(100, Math.max(1, parseInt(limitStr, 10) || 20))
      : 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  /** uni.request GET 常把 undefined 序列化为字符串 "undefined" */
  private cleanQueryParam(value?: string | null): string | undefined {
    if (value == null) return undefined;
    const trimmed = String(value).trim();
    if (
      !trimmed ||
      trimmed === 'undefined' ||
      trimmed === 'null' ||
      trimmed === 'NaN'
    ) {
      return undefined;
    }
    return trimmed;
  }

  private isValidSearch(search?: string) {
    return !!this.cleanQueryParam(search);
  }

  private allowFeedback(userId: number) {
    return this.hitRateLimit(
      this.feedbackRate,
      userId,
      MAX_FEEDBACK_PER_WINDOW,
      1,
    );
  }

  private allowErrorEvents(key: number | string, count: number) {
    return this.hitRateLimit(
      this.errorRate,
      key,
      MAX_ERROR_EVENTS_PER_WINDOW,
      count,
    );
  }

  private hitRateLimit(
    store: Map<any, number[]>,
    key: any,
    max: number,
    add: number,
  ) {
    const now = Date.now();
    const list = (store.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length + add > max) {
      store.set(key, list);
      return false;
    }
    for (let i = 0; i < add; i++) list.push(now);
    store.set(key, list);
    return true;
  }
}
