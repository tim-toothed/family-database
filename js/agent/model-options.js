export const AGENT_TASK_TYPES = [
  {
    id: 'person_editing',
    label: 'Редактирование персон',
  },
];

export const AGENT_PROVIDER_OPTIONS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    ],
  },
];

export const DEFAULT_AGENT_PROVIDER = 'deepseek';
export const DEFAULT_AGENT_MODEL = 'deepseek-v4-flash';
export const DEFAULT_AGENT_TASK_TYPE = 'person_editing';
export const DEFAULT_AGENT_THINKING_MODE = 'thinking';

export const AGENT_THINKING_MODES = [
  {
    id: 'thinking',
    label: 'Thinking',
  },
  {
    id: 'non_thinking',
    label: 'Non-Thinking',
  },
];
