import { SUPABASE_CONFIG } from '../../config.js';
import { ensureSupabaseConfig, getSchemaClient } from './client.js';

function ensureDocumentConfig() {
  ensureSupabaseConfig('Supabase не настроен для документов в js/config.js.');
  if (
    !SUPABASE_CONFIG?.tables?.textDocuments
    || !SUPABASE_CONFIG?.tables?.textDocumentBlocks
    || !SUPABASE_CONFIG?.tables?.textDocumentMentions
  ) {
    throw new Error('Supabase не настроен для документов в js/config.js.');
  }
}

async function fetchSupabasePagedRows(table, selectClause, options = {}) {
  ensureDocumentConfig();

  const client = await getSchemaClient();
  const pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    let query = client
      .from(table)
      .select(selectClause)
      .range(from, from + pageSize - 1);

    for (const order of options.orders || []) {
      query = query.order(order.column, { ascending: order.ascending !== false });
    }

    for (const filter of options.filters || []) {
      query = query.eq(filter.column, filter.value);
    }

    for (const filter of options.rangeFilters || []) {
      if (filter.operator === 'gte') {
        query = query.gte(filter.column, filter.value);
      } else if (filter.operator === 'lte') {
        query = query.lte(filter.column, filter.value);
      }
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows;
}

async function fetchSupabaseRangeRows(table, selectClause, options = {}) {
  ensureDocumentConfig();

  const client = await getSchemaClient();
  let query = client
    .from(table)
    .select(selectClause)
    .range(options.from || 0, options.to || 0);

  for (const order of options.orders || []) {
    query = query.order(order.column, { ascending: order.ascending !== false });
  }

  for (const filter of options.filters || []) {
    query = query.eq(filter.column, filter.value);
  }

  for (const filter of options.rangeFilters || []) {
    if (filter.operator === 'gte') {
      query = query.gte(filter.column, filter.value);
    } else if (filter.operator === 'lte') {
      query = query.lte(filter.column, filter.value);
    }
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  return Array.isArray(data) ? data : [];
}

export async function fetchSupabaseDocumentManifestRows() {
  return fetchSupabasePagedRows(
    SUPABASE_CONFIG.tables.textDocuments,
    'id,title,description,source_type,source_path,block_count,mention_count,generated_at',
    {
      orders: [{ column: 'title', ascending: true }],
      pageSize: 500,
    },
  );
}

export async function fetchSupabaseDocumentPayloadRows(documentId) {
  return Promise.all([
    fetchSupabasePagedRows(
      SUPABASE_CONFIG.tables.textDocumentBlocks,
      'block_index,kind,text,mention_count',
      {
        filters: [{ column: 'document_id', value: documentId }],
        orders: [{ column: 'block_index', ascending: true }],
        pageSize: 1000,
      },
    ),
    fetchSupabasePagedRows(
      SUPABASE_CONFIG.tables.textDocumentMentions,
      'block_index,mention_index,kind,text,start_offset,end_offset,source',
      {
        filters: [{ column: 'document_id', value: documentId }],
        orders: [
          { column: 'block_index', ascending: true },
          { column: 'mention_index', ascending: true },
        ],
        pageSize: 1000,
      },
    ),
  ]);
}

export async function fetchSupabaseDocumentChunkRows(documentId, { from, to }) {
  const blocks = await fetchSupabaseRangeRows(
    SUPABASE_CONFIG.tables.textDocumentBlocks,
    'block_index,kind,text,mention_count',
    {
      from,
      to,
      filters: [{ column: 'document_id', value: documentId }],
      orders: [{ column: 'block_index', ascending: true }],
    },
  );

  if (!blocks.length) {
    return { blocks, mentions: [] };
  }

  const firstBlockIndex = Number(blocks[0]?.block_index);
  const lastBlockIndex = Number(blocks[blocks.length - 1]?.block_index);

  const mentions = await fetchSupabasePagedRows(
    SUPABASE_CONFIG.tables.textDocumentMentions,
    'block_index,mention_index,kind,text,start_offset,end_offset,source',
    {
      filters: [{ column: 'document_id', value: documentId }],
      rangeFilters: [
        { column: 'block_index', operator: 'gte', value: firstBlockIndex },
        { column: 'block_index', operator: 'lte', value: lastBlockIndex },
      ],
      orders: [
        { column: 'block_index', ascending: true },
        { column: 'mention_index', ascending: true },
      ],
      pageSize: 1000,
    },
  );

  return { blocks, mentions };
}
