import type { ChannelPlugin } from 'openclaw/plugin-sdk';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk';
import type { ResolvedMiAccount, ExtendedOpenClawConfig } from './types.js';
import {
  resolveMiAccount,
  listMiAccountIds,
  resolveDefaultMiAccountId,
  setMiAccountEnabled,
  deleteMiAccount,
  resolveMiAllowFrom,
  formatMiAllowFrom,
} from './config.js';
import { miOutbound } from './outbound.js';
import { miGPTOnboardingAdapter } from './onboarding.js';
import { MiService } from './service.js';
import { MiMessage } from './message.js';
import { sleep } from './utils/parse.js';
import { Debugger } from './utils/debug.js';
import { MiSpeaker } from './speaker.js';
import { getMiGPTRuntime } from './runtime.js';
import { OpenXiaoAI } from './mi-engine.js';

const meta = {
  id: 'migpt',
  label: 'MiGPT',
  selectionLabel: '小米音箱 (MiGPT)',
  docsPath: '/channels/migpt',
  docsLabel: 'migpt',
  blurb: '小米小爱音箱语音对话。',
  aliases: ['xiaomi', 'mico'],
  order: 60,
};

export const miGPTPlugin: ChannelPlugin<ResolvedMiAccount> = {
  id: 'migpt',
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ['direct'],
    polls: false,
    threads: false,
    media: true,
    reactions: false,
    edit: false,
    reply: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ['channels.migpt'] },
  onboarding: miGPTOnboardingAdapter,

  // 新增：Agent Prompt 配置，用于定制 AI 在音箱场景下的行为规范
  agentPrompt: {
    description: '音箱播报规范',
    getConfig: (cfg: any) => {
      const migptCfg = cfg.channels?.migpt;
      return {
        enabled: true,
        systemPrompt: migptCfg?.systemPrompt,
      };
    },
    applyConfig: (cfg: any, updates: any) => {
      const nextCfg = { ...cfg } as ExtendedOpenClawConfig;
      const nextMigpt = { ...nextCfg.channels?.migpt };
      if (updates.systemPrompt !== undefined) {
        nextMigpt.systemPrompt = updates.systemPrompt;
      }
      nextCfg.channels = { ...nextCfg.channels, migpt: nextMigpt };
      return nextCfg;
    },
  },

  config: {
    listAccountIds: (cfg) => listMiAccountIds(cfg as unknown as ExtendedOpenClawConfig),
    resolveAccount: (cfg, accountId) =>
      resolveMiAccount(cfg as unknown as ExtendedOpenClawConfig, accountId),
    defaultAccountId: (cfg) => resolveDefaultMiAccountId(cfg as unknown as ExtendedOpenClawConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setMiAccountEnabled(cfg as unknown as ExtendedOpenClawConfig, accountId, enabled),
    deleteAccount: ({ cfg, accountId }) =>
      deleteMiAccount(cfg as unknown as ExtendedOpenClawConfig, accountId),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      devices: account.devices,
    }),
    resolveAllowFrom: ({ cfg, accountId }: { cfg: any; accountId?: string }) =>
      resolveMiAllowFrom(cfg as unknown as ExtendedOpenClawConfig, accountId),
    formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) => formatMiAllowFrom(allowFrom),
  },

  setup: {
    resolveAccountId: ({ accountId }: { accountId?: string }) => accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId, input }: { cfg: any; accountId?: string; input: any }) => {
      const migptCfg = cfg.channels?.migpt ?? {};
      const accountConfig = {
        userId: input.userId,
        password: input.password,
        passToken: input.passToken,
        devices: input.devices,
        enabled: true,
      };

      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            migpt: {
              ...migptCfg,
              ...accountConfig,
            },
          },
        } as ExtendedOpenClawConfig;
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          migpt: {
            ...migptCfg,
            accounts: {
              ...migptCfg.accounts,
              [accountId]: accountConfig,
            },
          },
        },
      } as ExtendedOpenClawConfig;
    },
    validateInput: ({ input }: { input: any }) => {
      return null;
    },
  },

  messaging: {
    normalizeTarget: (target: string) => {
      // 支持格式：migpt:客厅音箱 或 客厅音箱
      let id = target.replace(/^migpt:/i, '');
      if (id.trim()) {
        return { ok: true, to: id.trim() };
      }
      return { ok: false, error: 'Invalid target format' };
    },
    targetResolver: {
      looksLikeId: (id: string): boolean => {
        // 简单的启发式判断：非空字符串
        return id.length > 0 && id.length < 100;
      },
      hint: 'MiGPT 目标格式：设备名称（如：客厅音箱）',
    },
  },

  outbound: miOutbound,

  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal, log, cfg } = ctx;

      log?.info(`[migpt:${account.accountId}] Starting gateway`);

      const deviceName = account.name ?? account.accountId;

      // 设置调试模式
      Debugger.debug = account.config.debug ?? false;

      // 更新状态
      ctx.setStatus({
        ...ctx.getStatus(),
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
      });

      // 启动 OpenXiaoAI 引擎（RustServer 监听消息，通过 onEvent 回调处理并播放回复）
      await OpenXiaoAI.start({ account, cfg, log });
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    buildChannelSummary: ({ snapshot }: { snapshot: any }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastConnectedAt: snapshot.lastConnectedAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }: { account: any; runtime: any }) => ({
      accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
      name: account?.name,
      enabled: account?.enabled ?? false,
      configured: Boolean(account?.configured),
      devices: account?.devices,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
};
