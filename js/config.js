export const CONFIG = {
  peopleDir: './data/people',
  peopleManifestPath: './data/people/index.json',
  personFileExtension: '.yaml',
  requireAuth: true,
  // supabase / yandex: продовый режим без зависимости от data/* в публичном репозитории.
  // auto: сначала Supabase, затем локальный fallback. local: всегда локальные файлы.
  dataSource: 'yandex',
};

export const SUPABASE_CONFIG = {
  url: 'https://ylrbjiciudweqmfnzghc.supabase.co',
  publishableKey: 'sb_publishable_WO_hUMzT6y8Nj3coug81Mg_8DsyoxYA',
  project: 'html_games',
  schema: 'family_site',
  tables: {
    people: 'family_people',
    yaml: 'family_yaml',
    textDocuments: 'text_documents',
    textDocumentBlocks: 'text_document_blocks',
    textDocumentMentions: 'text_document_mentions',
  },
};

export const YANDEX_DB_CONFIG = {
  apiUrl: 'https://functions.yandexcloud.net/d4ebrmtiseqef31cdo03',
  apiToken: '',
};

export const YANDEX_DOC_IMPORT_CONFIG = {
  apiUrl: 'https://functions.yandexcloud.net/d4ekv1u19pvbpl7j8oeq',
  apiToken: '',
};

export const YANDEX_DB_TOOLS_CONFIG = {
  apiUrl: 'https://functions.yandexcloud.net/d4euqsp0kr657a0iajvb',
  apiToken: '',
};

export const YANDEX_AI_AGENT_CONFIG = {
  apiUrl: 'https://functions.yandexcloud.net/d4ee371ghggntlst4p7b',
  apiToken: '',
};

export const FIELD_LABELS = {
  id: 'ID',
  birth_name: 'Имя при рождении',
  name_changes: 'Изменения имени',
  sex: 'Пол',
  birth: 'Рождение',
  death: 'Смерть',
  parents: 'Родители',
  siblings: 'Братья и сёстры',
  spouses: 'Супруги',
  children: 'Дети',
  education: 'Образование',
  class_title: 'Сословие / социальный статус',
  religion: 'Вероисповедание',
  nationality: 'Национальность',
  jobs: 'Работа',
  military_service: 'Военная служба',
  war_participation: 'Участие в конфликтах и военные годы',
  achievements: 'Достижения и награды',
  residences: 'Места проживания',
  hobbies: 'Хобби и интересы',
  character: 'Характер',
  appearance: 'Внешность',
  health: 'Здоровье',
  other_info: 'Дополнительная информация',
  sources: 'Источники',
  media: 'Медиа',
};

export const SECTION_ORDER = [
  'birth_name',
  'name_changes',
  'birth',
  'death',
  'parents',
  'siblings',
  'spouses',
  'children',
  'education',
  'class_title',
  'religion',
  'nationality',
  'jobs',
  'military_service',
  'war_participation',
  'achievements',
  'residences',
  'hobbies',
  'character',
  'appearance',
  'health',
  'other_info',
  'sources',
  'media',
];
