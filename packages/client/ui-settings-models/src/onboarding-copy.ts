/** 存放产品级 GUI 引导状态的持久化设置命名空间。 */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** 记录用户最后确认的欢迎声明版本。 */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * 仅在声明发生实质变化且所有用户都应重新看到时递增。确认记录按完全相等比较。
 */
export const WELCOME_NOTICE_VERSION = '2026-08-24.1'

/** 两种 GUI 语言使用的完整可编辑内测声明。 */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '内测声明',
    body: 'Coding 0.1 仍处于内测阶段，还有许多地方需要持续改进和打磨，欢迎开发者反馈。核心能力和基础 API 会在接下来一段时间快速迭代、持续演化。\n\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。',
    continueLabel: '继续',
  },
  en: {
    title: 'Internal Testing Notice',
    body: 'Coding 0.1 remains in internal testing. Many areas need further improvement, and we welcome feedback from developers. Its core capabilities and foundational APIs will continue to evolve rapidly over the coming months.\n\nWe look forward to exploring the limits of intelligence with developers around the world, building on open-source, open, reusable, and composable infrastructure.',
    continueLabel: 'Continue',
  },
} as const
