'use strict';

const MAX_MESSAGES = 6;
const DEFAULT_PROVIDER = 'deepseek';
const DEFAULT_MODEL_BY_PROVIDER = {
  deepseek: 'DeepSeek-V4-Flash',
};
const ALLOWED_MODELS_BY_PROVIDER = {
  deepseek: new Set(['DeepSeek-V4-Flash', 'deepseek-v4-pro']),
};
const ALLOWED_TASK_TYPES = new Set(['person_editing']);
const ALLOWED_THINKING_MODES = new Set(['thinking', 'non_thinking']);

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_people',
      description: 'Find person cards by ID or Russian display name. Use before asking the user to identify a card if the name is searchable.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_person',
      description: 'Read a full person card payload by ID.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string' },
        },
        required: ['person_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_person_payload',
      description: 'Create a new person card. If person_id is omitted, the tool assigns the next P-number. The payload_json value must be the complete new person payload as a JSON object string.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string' },
          payload_json: { type: 'string' },
        },
        required: ['payload_json'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_person_payload',
      description: 'Save the full updated payload of an existing person card. Use only after reading the card and only when the user explicitly asks to change/save data. The payload_json value must be the complete updated person payload as a JSON object string, preserving unrelated fields.',
      parameters: {
        type: 'object',
        properties: {
          person_id: { type: 'string' },
          payload_json: { type: 'string' },
        },
        required: ['person_id', 'payload_json'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_agent_guides',
      description: 'List available internal guides for card structure, relation editing and free-text fields.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_agent_guide',
      description: 'Read an internal guide by ID before making complex edits or choosing a target section.',
      parameters: {
        type: 'object',
        properties: {
          guide_id: { type: 'string' },
        },
        required: ['guide_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_public_url',
      description: 'Fetch and extract readable text from a public http/https URL provided by the user. Use for articles and public source pages before deciding where to put information.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
];

module.exports = {
  AGENT_TOOLS,
  ALLOWED_MODELS_BY_PROVIDER,
  ALLOWED_TASK_TYPES,
  ALLOWED_THINKING_MODES,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER,
  MAX_MESSAGES,
};
