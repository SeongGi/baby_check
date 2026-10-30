// Cloudflare D1 흉내입니다(06 설계 2.10). Node 24의 node:sqlite 위에서 서버 코드가 쓰는
// prepare, bind, first, all, run, raw, batch, exec를 만들고, 실제 D1의 한도와 과금 모형을 따릅니다.
//  - batch()는 BEGIN~COMMIT을 await 없이 동기로 실행합니다. 실패하면 ROLLBACK합니다.
//  - 문장 하나의 바인딩 값이 100개를 넘으면 오류가 납니다.
//  - Worker 호출 하나(runInvocation)의 쿼리가 50회를 넘어도 오류가 납니다. batch() 한 번은 1회로 셉니다.
//  - 읽은 행 수는 결과 행 수로, 쓴 행 수는 아래 모형으로 근사합니다(추측: 실제 D1 과금이 이 모형과
//    같은지는 배포 뒤 지표로 확인합니다).
//      삽입 한 건 = 1 + 그 테이블의 인덱스 수(sqlite_master의 자동 인덱스까지)
//      갱신 한 건 = 1 + SET이 바꾸는 열을 담은 인덱스 수(기본 키는 바뀌지 않으므로 자동 인덱스는 제외)
//      삭제 한 건 = 1 + 그 테이블의 인덱스 수
//    삽입 수는 문장 실행 전후의 테이블 행 수 차이로, 갱신 수는 meta.changes에서 삽입 수를 뺀 값으로 봅니다.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

export const D1_MAX_BIND_PARAMS = 100;
export const D1_MAX_QUERIES_PER_INVOCATION = 50;

const als = new AsyncLocalStorage();

const isReadSql = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);

// 문장이 바꾸는 테이블과 SET 열을 정규식으로 알아냅니다.
function describeSql(sql) {
  let m = /^\s*insert\s+(?:or\s+\w+\s+)?into\s+["`]?(\w+)/i.exec(sql);
  if (m) return { op: 'insert', table: m[1], setCols: upsertSetColumns(sql) };
  m = /^\s*update\s+(?:or\s+\w+\s+)?["`]?(\w+)/i.exec(sql);
  if (m) return { op: 'update', table: m[1], setCols: setColumns(sql, /\bSET\b/i) };
  m = /^\s*delete\s+from\s+["`]?(\w+)/i.exec(sql);
  if (m) return { op: 'delete', table: m[1], setCols: [] };
  return { op: null, table: null, setCols: [] };
}

function upsertSetColumns(sql) {
  const m = /\bDO\s+UPDATE\s+SET\b/i.exec(sql);
  if (!m) return [];
  return parseAssignments(sql.slice(m.index + m[0].length));
}

function setColumns(sql, pattern) {
  const m = pattern.exec(sql);
  if (!m) return [];
  return parseAssignments(sql.slice(m.index + m[0].length));
}

// "a = ?1, b = COALESCE(x, ''), c = 3 WHERE ..."에서 a, b, c를 꺼냅니다. 괄호 안의 쉼표는 건너뛰고
// 괄호 밖의 WHERE에서 멈춥니다.
function parseAssignments(text) {
  const pieces = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) { if (ch === "'") inString = false; continue; }
    if (ch === "'") { inString = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && ch === ',') { pieces.push(text.slice(start, i)); start = i + 1; }
    else if (depth === 0 && /^\s$/.test(text[i - 1] ?? ' ') && /^WHERE\s/i.test(text.slice(i, i + 6))) break;
  }
  pieces.push(text.slice(start));
  const columns = [];
  for (const piece of pieces) {
    const m = /^\s*["`]?(\w+)["`]?\s*=/.exec(piece);
    if (m) columns.push(m[1]);
  }
  return columns;
}

const d1Error = (message) => new Error(`D1_ERROR: ${message}`);

/**
 * @param {{ schemaSql: string, onBatch?: (ctx: any, batchKind: 'read'|'write', statementCount: number) => Promise<any> }} options
 */
export function createD1Mock({ schemaSql, onBatch }) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(schemaSql);

  const statementCache = new Map();
  const prepared = (sql) => {
    let statement = statementCache.get(sql);
    if (!statement) { statement = raw.prepare(sql); statementCache.set(sql, statement); }
    return statement;
  };

  const countCache = new Map();
  const tableCount = (table) => {
    let n = countCache.get(table);
    if (n === undefined) {
      n = Number(raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n);
      countCache.set(table, n);
    }
    return n;
  };
  const invalidateCounts = () => countCache.clear();

  const indexCache = new Map();
  const indexesOf = (table) => {
    let indexes = indexCache.get(table);
    if (!indexes) {
      indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table)
        .map((row) => ({
          name: row.name,
          auto: row.name.startsWith('sqlite_autoindex_'),
          columns: raw.prepare(`PRAGMA index_info("${row.name}")`).all().map((c) => c.name),
        }));
      indexCache.set(table, indexes);
    }
    return indexes;
  };

  const newContext = (extra = {}) => ({
    queries: 0,
    rowsRead: 0,
    rowsWritten: 0,
    writtenByTable: {},
    changedByTable: {},
    heldMs: 0,
    info: {},
    ...extra,
  });
  const currentContext = () => als.getStore() || newContext({ unbound: true });
  const runInvocation = (ctx, fn) => als.run(ctx, fn);

  const countQuery = (ctx) => {
    ctx.queries += 1;
    if (!ctx.unbound && ctx.queries > D1_MAX_QUERIES_PER_INVOCATION) {
      throw d1Error('Too many API requests by single worker invocation.');
    }
  };

  const checkValues = (values) => {
    if (values.length > D1_MAX_BIND_PARAMS) {
      throw d1Error(`too many SQL variables (${values.length} > ${D1_MAX_BIND_PARAMS})`);
    }
    return values.map((v) => {
      if (v === undefined) throw d1Error("Type 'undefined' not supported for value 'undefined'");
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
  };

  const addWritten = (ctx, table, rows, changes) => {
    ctx.rowsWritten += rows;
    ctx.writtenByTable[table] = (ctx.writtenByTable[table] || 0) + rows;
    ctx.changedByTable[table] = (ctx.changedByTable[table] || 0) + changes;
  };

  // 쓰기 문장 하나를 실행하고 집계합니다.
  function executeWrite(sql, values, ctx) {
    const info = describeSql(sql);
    let before = 0;
    let result;
    try {
      if (info.op === 'insert') before = tableCount(info.table);
      result = prepared(sql).run(...values);
    } catch (error) { throw d1Error(error.message); }
    const changes = Number(result.changes);
    if (info.table) {
      const all = indexesOf(info.table);
      let inserted = 0;
      let updated = 0;
      let deleted = 0;
      if (info.op === 'insert') {
        let after = before;
        if (changes > 0) { after = Number(raw.prepare(`SELECT count(*) AS n FROM "${info.table}"`).get().n); countCache.set(info.table, after); }
        inserted = Math.max(0, after - before);
        updated = changes - inserted;
      } else if (info.op === 'update') {
        updated = changes;
      } else if (info.op === 'delete') {
        deleted = changes;
        countCache.delete(info.table);
      }
      const affected = all.filter((index) => !index.auto && index.columns.some((c) => info.setCols.includes(c))).length;
      addWritten(ctx, info.table,
        inserted * (1 + all.length) + updated * (1 + affected) + deleted * (1 + all.length), changes);
    }
    return { results: [], success: true, meta: { changes, last_row_id: Number(result.lastInsertRowid) || 0, changed_db: changes > 0, rows_read: 0, rows_written: 0, duration: 0 } };
  }

  function executeRead(sql, values, ctx) {
    let rows;
    try { rows = prepared(sql).all(...values).map((row) => ({ ...row })); } catch (error) { throw d1Error(error.message); }
    ctx.rowsRead += rows.length;
    return { results: rows, success: true, meta: { changes: 0, rows_read: rows.length, rows_written: 0, duration: 0 } };
  }

  const executeOne = (sql, values, ctx) => (isReadSql(sql) ? executeRead(sql, values, ctx) : executeWrite(sql, values, ctx));

  class D1Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new D1Statement(this.sql, values); }
    async run() {
      const ctx = currentContext();
      countQuery(ctx);
      return executeOne(this.sql, checkValues(this.values), ctx);
    }
    async all() { return this.run(); }
    async first(column) {
      const result = await this.run();
      const row = result.results[0];
      if (!row) return null;
      return column === undefined ? row : row[column];
    }
    async raw() {
      const result = await this.run();
      return result.results.map((row) => Object.values(row));
    }
  }

  const snapshotCounters = (ctx) => ({
    rowsWritten: ctx.rowsWritten,
    writtenByTable: { ...ctx.writtenByTable },
    changedByTable: { ...ctx.changedByTable },
  });

  const db = {
    prepare: (sql) => new D1Statement(sql),
    async exec(sql) { raw.exec(sql); invalidateCounts(); return { count: 1, duration: 0 }; },
    async batch(statements) {
      const ctx = currentContext();
      countQuery(ctx);
      const specs = statements.map((s) => ({ sql: s.sql, values: checkValues(s.values) }));
      const batchKind = specs.some((s) => !isReadSql(s.sql)) ? 'write' : 'read';
      // 실제 D1은 BEGIN 전에 요청이 얼마든지 늦어질 수 있습니다. 훅은 여기서만 await합니다.
      const decision = (await onBatch?.(ctx, batchKind, specs.length)) || {};
      // 여기서부터 COMMIT까지는 await가 없으므로 다른 요청이 확정 전 행을 볼 수 없습니다.
      if (batchKind === 'read') return specs.map((s) => executeRead(s.sql, s.values, ctx));
      const saved = snapshotCounters(ctx);
      raw.exec('BEGIN');
      let results;
      try {
        results = specs.map((s) => executeOne(s.sql, s.values, ctx));
        if (decision.failBeforeCommit) throw d1Error('harness: injected failure before COMMIT');
        raw.exec('COMMIT');
      } catch (error) {
        try { raw.exec('ROLLBACK'); } catch { /* 이미 끝난 트랜잭션 */ }
        invalidateCounts();
        // 되돌린 쓰기는 확정되지 않았으므로 집계에서 뺍니다.
        ctx.rowsWritten = saved.rowsWritten;
        ctx.writtenByTable = saved.writtenByTable;
        ctx.changedByTable = saved.changedByTable;
        throw error;
      }
      if (decision.failAfterCommit) throw d1Error('harness: injected failure after COMMIT');
      return results;
    },
  };

  return { db, raw, newContext, runInvocation, invalidateCounts };
}
